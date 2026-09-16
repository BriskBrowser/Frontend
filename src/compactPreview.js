// A preview is deliberately passive until the matching interactive frame is
// committed. Text uses only a local font and never creates page markup.
export class CompactPreview {
  constructor(){this.generation=0;}
  async set(data,source,parent){
    const generation=++this.generation;
    const {width,height,text}=data;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||width>4096||height>4096||width*height>4*1024*1024||!Array.isArray(text)||text.length>20000)throw Error('Preview bounds');
    let total=0;
    for(const run of text){
      if(typeof run.text!=='string'||(total+=run.text.length)>200000||![run.x,run.y,run.width,run.fontSize,run.color].every(Number.isFinite)||run.width<0||run.width>8192||run.fontSize<=0||run.fontSize>4096||Math.abs(run.x)>8192||Math.abs(run.y)>8192||run.color<0||run.color>0xffffffff)throw Error('Preview text bounds');
    }
    let image=source;
    try{
      if(typeof source==='string'){
        // HTML images decode both raster and SVG compact primitives. Chromium
        // does not support SVG blobs in createImageBitmap on this path.
        image=new Image();image.src=source;await image.decode();
      }
      if(generation!==this.generation)return;
      if(!image||image.width!==width||image.height!==height)throw Error('Preview image dimensions');
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      for(const run of text){
        if(!run.width)continue;
        const color=run.color>>>0;ctx.fillStyle=`rgba(${(color>>>16)&255},${(color>>>8)&255},${color&255},${(color>>>24)/255})`;
        ctx.font=`${run.bold?'bold ':''}${run.fontSize}px Arial, sans-serif`;
        ctx.save();ctx.beginPath();ctx.rect(run.x,run.y-run.fontSize*1.25,run.width,run.fontSize*1.6);ctx.clip();
        ctx.fillText(run.text,run.x,run.y,run.width);ctx.restore();
      }
      canvas.className='compact-preview';
      Object.assign(canvas.style,{position:'absolute',left:'0',top:'0',width:width+'px',height:height+'px',zIndex:'2147483646',background:'white'});
      if(this.canvas)this.canvas.remove();this.canvas=canvas;
      this.attach(parent);
    }finally{if(typeof source==='string'&&source.startsWith('blob:'))URL.revokeObjectURL(source);}
  }
  attach(parent){if(parent&&this.canvas)parent.appendChild(this.canvas);}
  clear(){++this.generation;if(this.canvas)this.canvas.remove();this.canvas=null;}
}
