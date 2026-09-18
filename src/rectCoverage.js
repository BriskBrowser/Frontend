// Bounds are checked by the caller. Sweep rectangle edges instead of touching
// every destination pixel. Work is O(rectangles * log(width)), independent of
// image area. Removing before adding permits rectangles to share an edge.
export function assertDisjoint(rects, width) {
  if (rects.length < 2) return;
  const events = [];
  for (const r of rects) {
    events.push({y:r.y, x:r.x, end:r.x+r.rw, delta:1});
    events.push({y:r.y+r.rh, x:r.x, end:r.x+r.rw, delta:-1});
  }
  events.sort((a,b)=>a.y-b.y || a.delta-b.delta);
  const max = new Int16Array(width*4), lazy = new Int16Array(width*4);
  function add(node, left, right, from, to, delta) {
    if (from<=left && right<=to) {max[node]+=delta;lazy[node]+=delta;return;}
    const middle=(left+right)>>>1;
    if(from<middle)add(node*2,left,middle,from,to,delta);
    if(to>middle)add(node*2+1,middle,right,from,to,delta);
    max[node]=lazy[node]+Math.max(max[node*2],max[node*2+1]);
  }
  for(const e of events) {
    add(1,0,width,e.x,e.end,e.delta);
    if(max[1]>1)throw Error('Overlapping atlas');
  }
}
