import {TileStreamDecoder} from './tileStream.js';
import {assertDisjoint} from './rectCoverage.js';

// References contain exactly what this connection displayed, including codec
// loss. Never reconstruct copies from the server's uncompressed source pixels.
export class PatchAtlasDecoder {
  constructor() { this.images=new TileStreamDecoder(); this.refs=new Map(); this.next=0; this.bytes=0; }
  seed(image) {
    if(this.next || !image.width || !image.height || image.width*image.height>4*1024*1024)throw Error('Invalid startup seed');
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    canvas.getContext('2d').drawImage(image,0,0);canvas.sharable=true;
    this.seeded=true;
    this.refs.set(0,{canvas,quality:100});this.next=1;this.bytes=image.width*image.height*4;
  }
  async decode(bytes) {
    if(this.closed || bytes.length<32)throw Error('Invalid patch atlas');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const [magic,id,w,h,quality,metaSize,imageSize,flags]=Array.from({length:8},(_,i)=>v.getUint32(i*4,true));
    if(magic!==0x31415042||id!==this.next||!w||!h||w>4096||h>4096||w*h>4*1024*1024||quality>100||flags>1||metaSize>128*1024||32+metaSize+imageSize!==bytes.length)throw Error('Patch atlas bounds or sequence');
    const reader=new Blob([bytes.subarray(32,32+metaSize)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let length=0;const chunks=[];
    try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>12+4096*28)throw Error('Atlas metadata too large');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const plain=new Uint8Array(length);let offset=0;for(const chunk of chunks){plain.set(chunk,offset);offset+=chunk.length;}
    if(length<12)throw Error('Truncated atlas metadata');
    const m=new DataView(plain.buffer),aw=m.getUint32(0,true),ah=m.getUint32(4,true),count=m.getUint32(8,true);
    if(!count||count>4096||length!==12+count*28||aw>4096||ah>4096||aw*ah>4*1024*1024||!!imageSize!==!!(aw&&ah)||(!imageSize&&(aw||ah)))throw Error('Invalid atlas dimensions');
    if(flags&&(!imageSize||ah%2))throw Error('Invalid atlas alpha plane');
    const colorHeight=flags?ah/2:ah;
    // Validate the complete operation list before advancing a video decoder.
    const rects=[];let area=0,novel=0;
    for(let i=0;i<count;i++){
      const [base,sx,sy,x,y,rw,rh]=Array.from({length:7},(_,j)=>m.getUint32(12+i*28+j*4,true));
      if(!rw||!rh||x+rw>w||y+rh>h)throw Error('Atlas destination bounds');
      const source=base===0xffffffff?null:this.refs.get(base);
      if(base===0xffffffff){if(!imageSize||sx+rw>aw||sy+rh>colorHeight)throw Error('Atlas source bounds');novel++;}
      else if(!source||source.quality<quality||sx+rw>source.canvas.width||sy+rh>source.canvas.height)throw Error('Missing atlas reference or quality');
      area+=rw*rh;if(area>w*h)throw Error('Overlapping atlas');
      rects.push({source,sx,sy,x,y,rw,rh});
    }
    if(area!==w*h||!!imageSize!==!!novel)throw Error('Incomplete atlas coverage');
    assertDisjoint(rects,w);
    let atlas=imageSize?await this.images.decode(bytes.subarray(32+metaSize)):null;
    if(this.closed)throw Error('Patch atlas closed');
    if(atlas&&(atlas.width!==aw||atlas.height!==ah))throw Error('Atlas image dimensions changed');
    if(flags){
      const pixels=atlas.getContext('2d').getImageData(0,0,aw,ah).data;
      const color=new Uint8ClampedArray(pixels.slice(0,aw*colorHeight*4));
      for(let p=3;p<color.length;p+=4)color[p]=pixels[color.length+p-3];
      const combined=document.createElement('canvas');combined.width=aw;combined.height=colorHeight;
      combined.getContext('2d').putImageData(new ImageData(color,aw,colorHeight),0,0);atlas=combined;
    }
    const r=rects[0];
    const shared=rects.length===1 && r.source && !r.sx && !r.sy &&
      r.source.canvas.width===w && r.source.canvas.height===h;
    const canvas=shared?r.source.canvas:document.createElement('canvas');
    if(!shared){
      canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');
      for(const r of rects)ctx.drawImage(r.source?r.source.canvas:atlas,r.sx,r.sy,r.rw,r.rh,r.x,r.y,r.rw,r.rh);
    }
    canvas.sharable=true;this.refs.set(id,{canvas,quality});this.bytes+=w*h*4;this.next++;
    while(this.refs.size){const first=this.refs.keys().next().value;if(first+8>=this.next&&this.bytes<=32*1024*1024)break;const old=this.refs.get(first).canvas;this.bytes-=old.width*old.height*4;this.refs.delete(first);}
    return canvas;
  }
  close(){this.closed=true;this.images.close();this.refs.clear();this.bytes=0;}
}
