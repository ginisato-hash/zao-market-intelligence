import {constants,openSync,closeSync,fstatSync,readSync} from 'node:fs';
/** Enforce the actual read budget even if a regular file grows after the initial stat. No symlink following. */
export function readBoundedStableFile(path:string,max:number):Buffer{
 if(!Number.isSafeInteger(max)||max<1||max>32*1024*1024)throw Error('STABLE_READ_BUDGET');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{return readBoundedStableFd(fd,max);}finally{closeSync(fd);}
}
export function readBoundedStableFd(fd:number,max:number):Buffer{
 if(!Number.isSafeInteger(max)||max<1||max>32*1024*1024)throw Error('STABLE_READ_BUDGET');
  const a=fstatSync(fd,{bigint:true});if(!a.isFile()||a.size>BigInt(max))throw Error('STABLE_READ_SIZE');
  const bytes=Buffer.alloc(max+1);let length=0;
  while(length<bytes.length){const n=readSync(fd,bytes,length,Math.min(32768,bytes.length-length),null);if(n===0)break;length+=n;}
  if(length>max)throw Error('STABLE_READ_GREW_PAST_BUDGET');
  const b=fstatSync(fd,{bigint:true});
  if(a.dev!==b.dev||a.ino!==b.ino||a.size!==b.size||a.mtimeNs!==b.mtimeNs||a.ctimeNs!==b.ctimeNs||BigInt(length)!==b.size)throw Error('STABLE_READ_CHANGED');
  return Buffer.from(bytes.subarray(0,length));
}

