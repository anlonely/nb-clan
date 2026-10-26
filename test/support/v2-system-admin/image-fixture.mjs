import {deflateSync,crc32} from 'node:zlib';
export function pngFixture(width=128,height=128) {
 let state=20260908; const data=Buffer.alloc(height*(width*4+1));
 for(let y=0;y<height;y++) for(let x=0;x<width*4;x++){state=(Math.imul(state,1664525)+1013904223)>>>0;data[y*(width*4+1)+1+x]=state>>>24;}
 const chunk=(type,body)=>{const name=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(body.length);tail.writeUInt32BE(crc32(Buffer.concat([name,body])));return Buffer.concat([head,name,body,tail]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
