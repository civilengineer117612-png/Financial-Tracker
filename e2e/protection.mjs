// Browser integration: request timing, durable once-only claim, truthful Setup,
// and unsupported/error paths. All state and accounts here are invented.
export async function protectionChecks({ browser, base, open, addAccount, menuGo, check }) {
  const origin = new URL(base).origin;
  for (const mode of ["granted", "refused", "missing", "throws", "pending"]) {
    const {ctx,page,errors}=await open({blockSw:true, storageMode:mode});
    try {
      check(await page.evaluate(()=>window.__persistCalls)===0, mode+": no storage request during startup or quiet saves");
      await addAccount(page,"Example First","asset","100");
      if(mode!=="missing") await page.waitForFunction(()=>window.__persistCalls===1);
      if(mode==="pending") {
        await page.waitForFunction(()=>document.querySelector('#toast')?.innerText.includes('Added Example First'),null,{timeout:4000});
        check(true,'an unanswered permission request does not delay the completed-save message');
      }
      await addAccount(page,"Example Second","asset","200");
      check(await page.evaluate(()=>window.__persistCalls)===(mode==="missing"?0:1),mode+": a successful save requests only once; another save still works");
      await menuGo(page,"Setup");
      await page.locator('#about-protection').waitFor();
      await page.waitForFunction(expected=>document.getElementById('about-protection')?.textContent===expected,"Storage protected: "+(mode==="granted"?"yes":"no"));
      check(await page.locator('#about-protection').innerText()==="Storage protected: "+(mode==="granted"?"yes":"no"),mode+": Setup reports the actual result");
      await page.reload();await page.waitForSelector('#nav button');
      await addAccount(page,"Example Third","asset","300");
      check(await page.evaluate(()=>window.__persistCalls)===0,mode+": reload and another save do not repeat the request");
      // The real store transaction must serialize competing claims too.
      const claims=await page.evaluate(async()=>{const {claimPersistenceRequest}=await import('./store.js');return await Promise.all([claimPersistenceRequest(),claimPersistenceRequest()]);});
      check(claims.filter(Boolean).length===(mode==="missing"?1:0),mode+": durable claim serializes concurrent callers");
      check(errors.length===0,mode+": no page errors and logging remains available");
    }finally{await ctx.close();}
  }
  {
    const {ctx,page}=await open({blockSw:true,storageMode:'refused',routes:[['**/app/store.js',s=>s.replace('async function idbPut(text) {','async function idbPut(text) { if (globalThis.__failLedgerWrite) throw new Error("invented write failure");')]]});
    try{
      await page.evaluate(()=>{window.__failLedgerWrite=true;});
      await addAccount(page,'Example Failed Save','asset','100');
      check(await page.evaluate(()=>window.__persistCalls)===0,'a failed IndexedDB save does not request storage protection');
      await page.evaluate(()=>{window.__failLedgerWrite=false;});
      await addAccount(page,'Example Successful Save','asset','200');
      await page.waitForFunction(()=>window.__persistCalls===1);
      check(true,'the first successful save after a failure requests storage protection');
    }finally{await ctx.close();}
  }
  // Record a genuine engine answer on an isolated origin, without any API mock.
  const ctx=await browser.newContext({serviceWorkers:'block'});
  try{
    const page=await ctx.newPage();await page.goto(origin+'/app/index.html');
    const answer=await page.evaluate(async()=>{
      const {writeBoth}=await import('./store.js');const {emptyLedger}=await import('../src/model/index.js');
      const saved=await writeBoth(JSON.stringify(emptyLedger()));
      const supported=typeof navigator.storage?.persist==='function';
      return {saved:saved.idb,supported,request:supported?await navigator.storage.persist():null,persisted:typeof navigator.storage?.persisted==='function'?await navigator.storage.persisted():null};
    });
    check(answer.saved===true,'native engine measurement follows a successful isolated IndexedDB save');
    console.log('Native storage API result (isolated test origin, not an iPhone): '+JSON.stringify(answer));
  }finally{await ctx.close();}
}
