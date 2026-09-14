import {Vp9TileDecoder} from './h264tiles.js';
// Physical-socket state: all forks share these references. Tile-store eviction
// does not change codec residency, and canvas placement never moves these bases.
export class TileStreamDecoder {
  constructor() {this.next = 0; this.refs = new Map(); this.streams = new Map(); this.bytes = 0;}
  async decode(bytes) {
    if (this.closed || bytes.byteLength < 40) throw Error('Invalid tile stream packet');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [magic,id,w,h,kind,slot,epoch,sequence,key,length] = Array.from({length:10},(_,i)=>v.getUint32(i*4,true));
    if (magic !== 0x31535442 || id !== this.next || !w || !h || w>4096 || h>4096 || w*h>4*1024*1024 || length!==bytes.length-40 || kind>4) throw Error('Tile stream bounds or sequence');
    const data=bytes.subarray(40);let canvas;
    if (kind===1) canvas=await this.video(data,slot,epoch,sequence,key,w,h);
    else if (kind===2) {if(!this.vp9)this.vp9=new Vp9TileDecoder();canvas=await this.vp9.decode(data);}
    else if(kind>=3){const bitmap=await createImageBitmap(new Blob([data],{type:'image/webp'}));try{if(bitmap.width!==w||bitmap.height!==h)throw Error('Image dimensions changed');canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(bitmap,0,0);}finally{bitmap.close();}}
    else canvas=await this.patch(data,w,h,key);
    if (this.closed) throw Error('Tile stream closed');
    if(canvas.width!==w||canvas.height!==h)throw Error('Tile dimensions changed');
    canvas.sharable=true;
    if(kind===0||kind===3){this.refs.set(id,canvas);this.bytes+=w*h*4;}
    this.next++;
    while(this.refs.size){const first=this.refs.keys().next().value;if(first+8>=this.next&&this.bytes<=32*1024*1024)break;const old=this.refs.get(first);this.bytes-=old.width*old.height*4;this.refs.delete(first);}
    return canvas;
  }
  video(data,slot,epoch,sequence,key,w,h) {
    if(slot>=4 || key>1)throw Error('Invalid video stream');
    let state=this.streams.get(slot);
    if(!state||state.epoch!==epoch){
      if(!key||sequence!==0)throw Error('Missing video reset frame');
      if(state)state.decoder.close();
      let codec;
      for(let i=0;i+6<data.length;i++)if(data[i]===0&&data[i+1]===0&&data[i+2]===1&&(data[i+3]&31)===7){codec='avc1.'+Array.from(data.slice(i+4,i+7),b=>b.toString(16).padStart(2,'0')).join('');break;}
      if(!codec)throw Error('Video reset missing SPS');
      state={epoch,next:0,pending:null};
      state.decoder=new VideoDecoder({error:error=>{if(state.pending)state.pending.fail(error);},output:frame=>{
        try {const pending=state.pending;if(!pending)return;
          if(frame.timestamp!==pending.sequence||frame.displayWidth!==Math.ceil(pending.w/16)*16||frame.displayHeight!==Math.ceil(pending.h/16)*16)throw Error('Video frame identity changed');
          const canvas=document.createElement('canvas');canvas.width=pending.w;canvas.height=pending.h;canvas.getContext('2d',{alpha:false}).drawImage(frame,0,0);pending.finish(canvas);
        } catch(error){if(state.pending)state.pending.fail(error);} finally {frame.close();}
      }});
      try {state.decoder.configure({codec,optimizeForLatency:true,hardwareAcceleration:'prefer-software'});}catch(error){state.decoder.close();throw error;}
      this.streams.set(slot,state);
    }
    if(sequence!==state.next++||state.pending)throw Error('Video sequence gap');
    return new Promise((resolve,reject)=>{
      const finish=canvas=>{clearTimeout(timer);state.pending=null;resolve(canvas);};
      const fail=error=>{clearTimeout(timer);state.pending=null;reject(error);};
      const timer=setTimeout(()=>fail(Error('Video decode timed out')),5000);
      state.pending={sequence,w,h,finish,fail};
      try {state.decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:sequence,data}));}catch(error){fail(error);}
      // Never flush between dependent frames: it requires the next input to be key.
    });
  }
  async patch(data,w,h,predictor) {
    if(predictor>1)throw Error('Invalid patch predictor');
    const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const parts=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4+w*h*4+256*28)throw Error('Patch exceeds size limit');parts.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    if(size<4)throw Error('Truncated patch');const v=new DataView(bytes.buffer),count=v.getUint32(0,true);let cursor=4+28*count;
    if(!count||count>256||cursor>size)throw Error('Invalid patch rectangles');
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');
    // Rectangle coverage is checked, so transparent copies never blend over
    // another operation and missing literal data cannot silently clear pixels.
    const occupied=[];let area=0;
    for(let i=0;i<count;i++){
      const [base,sx,sy,x,y,rw,rh]=Array.from({length:7},(_,j)=>v.getUint32(4+i*28+j*4,true));
      if(!rw||!rh||x+rw>w||y+rh>h)throw Error('Invalid patch rectangle');
      if(occupied.some(r=>x<r.x+r.w&&x+rw>r.x&&y<r.y+r.h&&y+rh>r.y))throw Error('Overlapping patch');
      occupied.push({x,y,w:rw,h:rh});area+=rw*rh;
      if(base===0xffffffff){const length=rw*rh*4;if(cursor+length>size)throw Error('Truncated patch pixels');if(predictor)for(let row=0;row<rh;row++)for(let p=4;p<rw*4;p++){const at=cursor+row*rw*4+p;bytes[at]=(bytes[at]+bytes[at-4])&255;}ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer,cursor,length),rw,rh),x,y);cursor+=length;}
      else {const source=this.refs.get(base);if(!source||sx+rw>source.width||sy+rh>source.height)throw Error('Missing patch reference');ctx.drawImage(source,sx,sy,rw,rh,x,y,rw,rh);}
    }
    if(cursor!==size||area!==w*h)throw Error('Incomplete patch');
    return canvas;
  }
  close(){this.closed=true;for(const state of this.streams.values()){if(state.pending)state.pending.fail(Error('Tile stream closed'));if(state.decoder.state!=='closed')state.decoder.close();}this.streams.clear();this.refs.clear();if(this.vp9)this.vp9.close();}
}
