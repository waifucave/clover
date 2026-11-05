import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const pause=(/** @type {any} */ ms)=>new Promise(r=>setTimeout(r,ms));
/** CDP methods route to the focused RenderWidgetHost, unlike Electron sendInputEvent keys.
 * @param {any} win @param {any} app */
export async function crossingCheck(win,app){
 const wc=win.webContents,frames=wc.mainFrame.frames.sort((/** @type {any} */ a,/** @type {any} */ b)=>a.url.localeCompare(b.url));
 const [one,two]=frames;
 app.focus({steal:true});win.focus();wc.focus();await pause(250);
 wc.debugger.attach('1.3');
 const send=(/** @type {any} */ method,args={})=>wc.debugger.sendCommand(method,args);
 const state=async()=>Promise.all(frames.map(async (/** @type {any} */ f)=>({url:f.url,...await f.executeJavaScript('({active:document.activeElement.id,focused:document.hasFocus(),value:document.querySelector("#first").value,events:window.events})')})));
 const key=async(/** @type {any} */ key,/** @type {any} */ code,/** @type {any} */ vk,modifiers=0,/** @type {any} */ text='')=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,modifiers,...(text?{text,unmodifiedText:text}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});await pause(80);};
 await one.executeJavaScript('document.querySelector("#first").focus()');
 await key('a','KeyA',65,0,'a');await send('Input.insertText',{text:'b'});await pause(150);
 const typing=await state(),tabSteps=[];
 for(let i=0;i<4;i++){await key('Tab','Tab',9);tabSteps.push(await state());}
 await key('Tab','Tab',9,8);const shiftTab=await state();
 await one.executeJavaScript('document.querySelector("#first").focus();document.querySelector("#first").select()');
 let ime;
 try{await send('Input.imeSetComposition',{text:'に',selectionStart:1,selectionEnd:1});await send('Input.insertText',{text:'日本'});await pause(150);ime=await state();}catch(e){ime={error:String(e)};}
 let shortcuts=0;const onInput=(/** @type {any} */ _e,/** @type {any} */ input)=>{if(input.key.toLowerCase()==='k'&&input.control)shortcuts++};wc.on('before-input-event',onInput);await key('k','KeyK',75,2);wc.removeListener('before-input-event',onInput);
 await wc.executeJavaScript('const overlay=document.createElement("input");overlay.id="overlay";document.body.append(overlay);overlay.focus()');
 const overlayFocus=await wc.executeJavaScript('document.activeElement.id');await wc.executeJavaScript('document.querySelector("#overlay").remove()');await one.executeJavaScript('document.querySelector("#first").focus()');const restored=await state();
 writeFileSync('results/menu-clipped.png',(await wc.capturePage()).toPNG());
 await wc.executeJavaScript('const menu=document.createElement("div");menu.id="overlay";menu.textContent="Core menu";document.body.append(menu)');
 writeFileSync('results/menu-host.png',(await wc.capturePage()).toPNG());await wc.executeJavaScript('document.querySelector("#overlay").remove()');
 /** @type {any} */ let intercepted=null;
/** @type {any[]} */ const messages=[];
 const onMessage=(/** @type {any} */ _e,/** @type {any} */ method,/** @type {any} */ params)=>{if(method==='Input.dragIntercepted'){intercepted=params.data;messages.push({method,data:params.data})}};wc.debugger.on('message',onMessage);
 await send('Input.setInterceptDrags',{enabled:true});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:35,y:50});
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:35,y:50,button:'left',buttons:1,clickCount:1});
 for(const x of [40,50,70,110,160,210]){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:60,button:'left',buttons:1});await pause(70);}
 await pause(200);
 if(intercepted){for(const type of ['dragEnter','dragOver','drop'])await send('Input.dispatchDragEvent',{type,x:215,y:85,data:intercepted});}
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:215,y:85,button:'left',buttons:0,clickCount:1});await pause(200);
 await send('Input.setInterceptDrags',{enabled:false});wc.debugger.removeListener('message',onMessage);
 const drag=await state();
 let xdotool=null;
 if(process.platform==='linux'){
  await one.executeJavaScript('document.querySelector("#first").focus();document.querySelector("#first").select()');
  try{const id=execFileSync('xdotool',['search','--pid',String(process.pid),'--name','Clover S9'],{encoding:'utf8',timeout:3000}).trim().split('\n')[0];execFileSync('xdotool',['windowfocus','--sync',id],{timeout:3000});execFileSync('xdotool',['type','--clearmodifiers','xvfb'],{timeout:3000});execFileSync('xdotool',['key','Tab'],{timeout:3000});await pause(200);xdotool=await state();}catch(e){xdotool={error:String(e)};}
 }
 const io=await one.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.srcdoc='<button style="width:50px;height:30px">fixture</button>';document.body.append(f);f.onload=()=>{try{const o=new f.contentWindow.IntersectionObserver(entries=>{o.disconnect();resolve(entries.map(e=>({isIntersecting:e.isIntersecting,isVisible:e.isVisible,ratio:e.intersectionRatio})))},{trackVisibility:true,delay:100});o.observe(f.contentDocument.querySelector('button'));}catch(e){resolve({error:String(e)})}};setTimeout(()=>resolve({timeout:true}),1200)})`);
 wc.debugger.detach();
 const passed=typing[0].value==='ab'&&Array.isArray(ime)&&ime[0].value==='日本'&&drag[1].events.some((/** @type {any} */ e)=>e.type==='drop'&&e.text==='clover-fixture');
 return {verdict:passed?'works with limits':'does not',typing,tabSteps,shiftTab,ime,shortcuts,overlayFocus,restored,dragIntercepted:messages,drag,xdotool,nestedIntersectionObserverV2:io,limits:['Synthetic composition does not test OS candidate windows.','Source-initiated text drag, not OS file dragging.','Hardware approval checks remain live gates.']};
}
