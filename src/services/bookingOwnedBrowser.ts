import {chromium,type Browser,type BrowserServer} from 'playwright';

type OwnedState={server:BrowserServer;kill:()=>Promise<void>;killStarted:boolean;unexpectedDisconnect:boolean;processExited:boolean;serverClosed:boolean;clientDisconnected:boolean};
const owners=new WeakMap<Browser,OwnedState>();
const remaining=(deadline:number)=>Math.max(0,deadline-performance.now());
async function bounded(pending:Promise<unknown>,deadline:number):Promise<void>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_BROWSER_TERMINATION_TIMEOUT')),remaining(deadline));})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}

/** One anonymous browser process per target. Never gracefully close a live page:
 * Chromium can dispatch unobservable keepalive traffic while doing so. Only the
 * public BrowserServer's captured owned process is killed, never a searched PID.
 */
export async function launchOwnedBookingBrowser():Promise<Browser>{
 // SharedWorker traffic is not covered by Playwright context routes. Keep that
 // unobservable execution path disabled at Chromium startup, including frames.
 const server=await chromium.launchServer({headless:true,host:'127.0.0.1',args:['--disable-shared-workers'],handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
 const child=server.process();
 let resolveExit!:()=>void,resolveClose!:()=>void;
 const exit=new Promise<void>(resolve=>{resolveExit=resolve;}),closed=new Promise<void>(resolve=>{resolveClose=resolve;});
 let killPromise:Promise<void>|null=null,disconnected:Promise<void>|null=null;
 const state:OwnedState={server,killStarted:false,unexpectedDisconnect:false,processExited:child.exitCode!==null||child.signalCode!==null,serverClosed:false,clientDisconnected:false,kill:()=>{
  if(killPromise)return killPromise;
  state.killStarted=true; // Before SIGKILL can synchronously start close callbacks.
  killPromise=Promise.resolve().then(()=>server.kill()).then(async()=>{
   await Promise.all([exit,closed,disconnected]);
   if(!state.processExited||!state.serverClosed||child.signalCode!=='SIGKILL')throw Error('OWNED_BROWSER_TERMINATION_UNVERIFIED');
  });
  return killPromise;
 }};
 child.once('exit',()=>{state.processExited=true;if(!state.killStarted)state.unexpectedDisconnect=true;resolveExit();});
 if(state.processExited)resolveExit();
 server.once('close',()=>{state.serverClosed=true;if(!state.killStarted)state.unexpectedDisconnect=true;resolveClose();});
 // Do not let Playwright's default signal handlers gracefully close live pages.
 const signals=['SIGINT','SIGTERM','SIGHUP'] as const;
 const handlers=signals.map(signal=>()=>{state.unexpectedDisconnect=true;void bounded(state.kill(),performance.now()+3000).catch(()=>{}).finally(()=>{process.removeListener(signal,handlers[signals.indexOf(signal)]!);process.kill(process.pid,signal);}).catch(()=>{});});
 signals.forEach((signal,i)=>process.once(signal,handlers[i]!));
 const removeSignals=()=>signals.forEach((signal,i)=>process.removeListener(signal,handlers[i]!));
 void closed.then(removeSignals);
 try{
  const browser=await chromium.connect(server.wsEndpoint());owners.set(browser,state);
  disconnected=new Promise<void>(resolve=>browser.once('disconnected',()=>{state.clientDisconnected=true;resolve();if(!state.killStarted){state.unexpectedDisconnect=true;void state.kill().catch(()=>{});}}));
  if(!browser.isConnected()){state.clientDisconnected=true;state.unexpectedDisconnect=true;disconnected=Promise.resolve();}
  return browser;
 }catch(error){await bounded(state.kill(),performance.now()+3000).catch(()=>{});throw error;}
}

export function isOwnedBookingBrowser(browser:Browser|null):boolean{return browser!==null&&owners.has(browser);}
export function ownedBookingBrowserStatus(browser:Browser|null){
 const s=browser===null?undefined:owners.get(browser);
 return {owned:s!==undefined,terminationStarted:s?.killStarted===true,processExited:s?.processExited===true,serverClosed:s?.serverClosed===true,clientDisconnected:s?.clientDisconnected===true,unexpectedDisconnect:s?.unexpectedDisconnect===true};
}
export async function terminateOwnedBookingBrowser(browser:Browser,deadline=performance.now()+3000):Promise<void>{
 const state=owners.get(browser);if(!state)throw Error('OWNED_BOOKING_BROWSER_REQUIRED');
 // Issue kill even if drain already used the entire deadline. Never fall back to
 // page/context/browser.close(), and never advance to another target on timeout.
 const pending=state.kill();await bounded(pending,deadline);
 if(state.unexpectedDisconnect)throw Error('OWNED_BROWSER_DISCONNECTED');
}
