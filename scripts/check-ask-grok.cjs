const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage();
    await page.route('**/*', r => r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'}));
    await page.goto('https://x.com/home');
    await page.setContent(`<a data-testid="AppTabBar_Profile_Link" href="/viewer">Profile</a><article><div data-testid="tweetText">English 中文 😀</div></article><textarea id="post">Post draft</textarea><section id="drawer"><button data-testid="GrokDrawerHeader">Grok</button><div id="body" hidden><textarea placeholder="Ask anything"></textarea><button id="send">Send</button></div></section>`);
    await page.evaluate(() => {
      window.messages=[]; window.sent=0;
      window.chrome={runtime:{sendMessage:async m=>{messages.push(m);return {ok:true}}}};
      document.querySelector('[data-testid="GrokDrawerHeader"]').onclick=()=>document.querySelector('#body').hidden=false;
      document.querySelector('#send').onclick=()=>sent++;
      window.selectText = text => {
        const el=document.querySelector('[data-testid="tweetText"]'); el.style.whiteSpace="pre-wrap"; el.textContent=text;
        const range=document.createRange();range.selectNodeContents(el);
        getSelection().removeAllRanges();getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      };
    });
    for (const file of ['src/shared/core.js','src/content/grok-draft.js','src/content/keyword-selection.js']) await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    const ask=page.getByRole('button',{name:'Ask Grok about selected text',exact:true});
    const mute=page.getByRole('button',{name:'Mute selected word on X',exact:true});
    await page.evaluate(()=>selectText('English 中文 😀'));
    await ask.click();
    assert.equal(await page.locator('#body textarea').inputValue(),'English 中文 😀');
    assert.equal(await page.locator('#post').inputValue(),'Post draft');
    assert.equal(await page.evaluate(()=>sent),0);
    console.log('PASS selection opens Grok with exact selected text');
    await page.evaluate(()=>selectText('Follow-up\n第二行'));
    await ask.click();
    assert.equal(await page.locator('#body textarea').inputValue(),'English 中文 😀\n\nFollow-up\n第二行');
    console.log('PASS existing draft is preserved and multiline text appended');
    await page.evaluate(()=>selectText('a'.repeat(200)));
    await ask.waitFor(); assert.equal(await mute.isVisible(),false);
    await ask.click();
    assert.ok((await page.locator('#body textarea').inputValue()).endsWith('a'.repeat(200)));
    console.log('PASS long selections are eligible for Grok');
    await page.evaluate(()=>selectText('mute phrase')); await mute.click();
    assert.deepEqual(await page.evaluate(()=>messages),[{type:'OPEN_KEYWORDS',text:'mute phrase',viewer:'viewer'}]);
    console.log('PASS mute action retains its review flow');
    await page.evaluate(()=>{document.querySelector('#body textarea').remove(); const el=document.createElement('div');el.contentEditable='true';el.role='textbox';document.querySelector('#body').prepend(el);selectText('Editable 😀');});
    await ask.click();
    assert.equal(await page.locator('#body [role="textbox"]').innerText(),'Editable 😀');
    console.log('PASS contenteditable Grok composer receives plain text');
    await page.evaluate(()=>{document.querySelector('article').style.marginTop='150px';selectText('Selected phrase for Grok with enough space for both actions');});
    await ask.waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await page.evaluate(()=>{
      const shadow=document.querySelector('.xm-keyword-selection').shadowRoot;
      const bar=shadow.querySelector('.toolbar');
      const selected=getSelection().getRangeAt(0).getBoundingClientRect();
      const bounds=bar.getBoundingClientRect();
      return {top:bounds.top,bottom:bounds.bottom,right:bounds.right,selectedTop:selected.top,selectedRight:selected.right,
        divider:getComputedStyle(shadow.querySelector('.divider')).display,
        buttonBorder:getComputedStyle(shadow.querySelector('button')).borderTopWidth};
    });
    assert.ok(geometry.bottom<geometry.selectedTop);
    assert.ok(Math.abs(geometry.right-geometry.selectedRight)<1);
    assert.equal(geometry.buttonBorder,'0px');
    assert.notEqual(geometry.divider,'none');
    await page.mouse.move(0,0);
    assert.equal(await ask.locator('svg').count(),1);
    assert.equal(await mute.locator('svg').count(),1);
    assert.equal(await ask.locator('.tooltip').isVisible(),false);
    await ask.hover();
    assert.equal(await ask.locator('.tooltip').isVisible(),true);
    assert.equal(await ask.locator('.tooltip').textContent(),'Ask Grok');
    await mute.focus();
    assert.equal(await mute.locator('.tooltip').isVisible(),true);
    await page.mouse.move(0,0);
    await mute.evaluate(el=>el.blur());
    if(process.env.GROK_SCREENSHOT) await page.screenshot({path:process.env.GROK_SCREENSHOT});
    console.log('PASS one divided toolbar anchors above the right edge of the selection');
    await page.evaluate(()=>document.querySelector('article').style.marginTop='0');
    let layouts=0;
    for(const width of [320,390,768,1024,1440,1920]) for(const zoom of [0.8,1,1.5,2]) {
      await page.setViewportSize({width,height:600});
      await page.evaluate(z=>{document.documentElement.style.zoom=z;selectText('layout phrase');},zoom);
      await ask.waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const bounds=await ask.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
      await ask.click({trial:true});layouts++;
    }
    await page.evaluate(()=>document.querySelector('[data-testid="GrokDrawerHeader"]').remove());
    const failure=await page.evaluate(async()=>{try{await XpertGrokDraft.open('retry',location.pathname);}catch(e){return e.message;}});
    assert.match(failure,/Open the Grok drawer/);
    assert.equal(await page.evaluate(()=>sent),0);
    console.log('PASS unavailable Grok produces an actionable retry message');
    console.log(`PASS both actions remain reachable in ${layouts} viewport/zoom combinations`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
