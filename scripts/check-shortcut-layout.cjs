// Run with Playwright available through PLAYWRIGHT_MODULE or the Node module path.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const screens = [
  [320, 180], [320, 240], [360, 640], [375, 667], [390, 844], [414, 896],
  [600, 800], [768, 1024], [800, 600], [800, 1280], [1024, 600], [1024, 768],
  [1280, 720], [1280, 800], [1280, 1024], [1366, 768], [1440, 900], [1536, 864],
  [1600, 900], [1680, 1050], [1728, 1117], [1920, 1080], [1920, 1200],
  [2048, 1152], [2256, 1504], [2304, 1440], [2560, 1080], [2560, 1440],
  [2560, 1600], [2880, 1800], [3000, 2000], [3024, 1964], [3440, 1440],
  [3456, 2234], [3840, 1080], [3840, 1600], [3840, 2160], [5120, 1440],
  [5120, 2160], [5120, 2880], [6016, 3384], [7680, 2160], [7680, 4320],
  [1080, 1920], [1440, 2560], [2160, 3840]
];
const zooms = [0.5, 0.67, 0.8, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let checks = 0;

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Measure rendered DOM rectangles independently of the extension's geometry helper.
async function inspect(page, label) {
  await settle(page);
  const result = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height}; };
    const shortcut = document.querySelector(".xm-settings-shortcut");
    const anchors = [...document.querySelectorAll(".native")].filter(el => {
      const r = rect(el), s = getComputedStyle(el);
      return s.visibility === "visible" && +s.opacity > 0 && r.width > 0 && r.height > 0
        && el.offsetWidth <= 96 && el.offsetHeight <= 96
        && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }).sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return {shortcut:rect(shortcut), hidden:shortcut.hidden, anchor:anchors[0] && rect(anchors[0]),
      zoom:document.body.currentCSSZoom || 1, width:document.documentElement.clientWidth * (document.documentElement.currentCSSZoom || 1), height:innerHeight};
  });
  const {shortcut:s, anchor:a, zoom:z} = result;
  const near = (x,y) => Math.abs(x-y) <= 0.1;
  if (a) {
    if (result.hidden) {
      const above = a.top - a.height - 12*z >= 12*z;
      assert.ok(!above || a.left < 0 || a.right > result.width, `${label}: hidden with space above ${JSON.stringify(result)}`);
    } else {
      assert.ok(near(s.width,a.width) && near(s.height,a.height), `${label}: size ${JSON.stringify(result)}`);
      const above = near(s.left,a.left) && near(a.top-s.bottom,12*z);
      const beside = near(s.top, Math.max(12*z,a.top)) && (near(a.left-s.right,12*z) || near(s.left-a.right,12*z));
      assert.ok(above || beside, `${label}: alignment ${JSON.stringify(result)}`);
      assert.ok(s.left >= -0.1 && s.top >= -0.1 && s.right <= result.width+0.1 && s.bottom <= result.height+0.1, `${label}: viewport bounds`);
      assert.ok(s.bottom <= a.top+0.1 || s.right <= a.left+0.1 || s.left >= a.right-0.1, `${label}: overlap`);
    }
  } else {
    assert.ok(!result.hidden && s.width > 0 && s.height > 0, `${label}: standalone shortcut`);
  }
  checks++;
}

async function fixture(page) {
  await page.setContent(`<style>
    html {overflow-y:scroll; scrollbar-gutter:stable;}
    body {margin:0;height:6000px;}
    #stack {position:fixed;right:21.25px;bottom:24px;display:flex;flex-direction:column;gap:12px;}
    .native {box-sizing:border-box;width:55.25px;height:55.25px;border:1px solid #9fb5c3;border-radius:16px;background:white;}
    @media(max-width:1000px){#stack{right:10.5px;bottom:20px}.native{width:48.5px;height:48.5px}}
    @media(prefers-color-scheme:dark){.native{background:#15202b;color:white}}
    </style><div id="stack"><button class="native" data-testid="GrokDrawerHeader">Grok</button><button class="native" data-testid="chat-drawer-main">Chat</button></div>`);
  await page.addStyleTag({content:fs.readFileSync(path.join(root,"src/content/content.css"),"utf8")});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,"src/shared/core.js"),"utf8")});
  await page.evaluate(() => {
    window.testSettingsChange = null;
    window.testMessages = [];
    window.XMuteStorage = {getState:async()=>({settings:XMuteCore.mergeSettings()}),setViewer:async()=>{}};
    window.chrome = {runtime:{onMessage:{addListener(){}},sendMessage:async m=>{testMessages.push(m)}},
      storage:{onChanged:{addListener(fn){window.testSettingsChange=fn}}}};
  });
  await page.addScriptTag({content:fs.readFileSync(path.join(root,"src/content/content.js"),"utf8")});
  await page.waitForSelector(".xm-settings-shortcut", {state:"attached"});
}

(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const context = await browser.newContext({deviceScaleFactor:dpr});
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await fixture(page);
      for (const [width,height] of screens) {
        await page.setViewportSize({width,height});
        for (const zoom of zooms) {
          await page.evaluate(z => document.documentElement.style.zoom=z, zoom);
          await inspect(page, `${width}x${height} DPR ${dpr} CSS zoom ${zoom}`);
        }
      }
      assert.deepEqual(errors, [], "browser runtime errors");
      await context.close();
      console.log(`PASS DPR ${dpr}; ${checks} rendered layouts checked`);
    }
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    await fixture(page);
    for (const colorScheme of ["light","dark"]) {
      await page.emulateMedia({colorScheme});
      await inspect(page, `${colorScheme} theme`);
      assert.ok(await page.evaluate(() => {
        const a=getComputedStyle(document.querySelector('.native')),s=getComputedStyle(document.querySelector('.xm-settings-shortcut'));
        return a.backgroundColor===s.backgroundColor && a.color===s.color && a.borderRadius===s.borderRadius;
      }), `${colorScheme} native appearance`);
    }
    // Sweep widths through breakpoint boundaries in both directions.
    for (const width of [...Array.from({length:161},(_,i)=>600+i*5), ...Array.from({length:161},(_,i)=>1400-i*5)]) {
      await page.setViewportSize({width,height:900});
      await inspect(page, `continuous resize ${width}`);
    }
    await page.evaluate(() => scrollTo(0,3000));
    await inspect(page,"scroll");
    await page.evaluate(() => {const s=document.querySelector('#stack');s.style.right='73.75px';s.style.bottom='180px'});
    await inspect(page,"position mutation");
    await page.evaluate(() => {const s=document.querySelector('.native');s.style.width='62.5px';s.style.height='62.5px'});
    await inspect(page,"size mutation");
    await page.evaluate(() => {const s=document.querySelector('.native');s.replaceWith(s.cloneNode(true))});
    await inspect(page,"native remount");
    await page.evaluate(() => {const s=document.createElement('style');s.textContent='.native{width:60.25px!important;height:60.25px!important}';document.head.append(s)});
    await inspect(page,"stylesheet resize");
    await page.evaluate(() => {const s=document.createElement('style');s.textContent='#stack{right:98.5px!important;bottom:130px!important}';document.head.append(s)});
    await inspect(page,"stylesheet position change");
    await page.evaluate(() => {document.querySelector('#stack').style.visibility='hidden'});
    await inspect(page,"hidden native controls");
    await page.evaluate(() => {document.querySelector('#stack').style.visibility='visible'});
    await inspect(page,"restored native controls");
    await page.evaluate(() => {document.querySelector('[data-testid="GrokDrawerHeader"]').hidden=true});
    await inspect(page,"Grok hidden; chat anchors the shortcut");
    await page.evaluate(() => {document.querySelector('[data-testid="GrokDrawerHeader"]').hidden=false});
    await inspect(page,"Grok restored");
    // Sample in the same animation frame after the extension's scheduled update.
    await page.evaluate(() => {const s=document.querySelector('#stack');s.style.transition='transform 400ms linear';s.style.transform='translateX(-120px)'});
    const animationErrors = await page.evaluate(async () => {
      const errors=[];
      for(let i=0;i<32;i++) {
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const a=document.querySelector('.native').getBoundingClientRect(),s=document.querySelector('.xm-settings-shortcut').getBoundingClientRect();
        // A rendered frame may straddle the first transition event; require tracking after startup.
        if(i>2 && Math.abs(a.left-s.left)>1) errors.push({frame:i,error:Math.abs(a.left-s.left)});
      }
      return errors;
    });
    assert.deepEqual(animationErrors,[],"animation tracking");
    await inspect(page,"transition completed");
    await page.evaluate(() => testSettingsChange({state:{newValue:{settings:{showShortcut:false}}}},'local'));
    await page.waitForFunction(() => !document.querySelector('.xm-settings-shortcut'));
    await page.evaluate(() => testSettingsChange({state:{newValue:{settings:{showShortcut:true}}}},'local'));
    await page.waitForSelector('.xm-settings-shortcut');
    await inspect(page,"shortcut re-enabled");
    await page.click('.xm-settings-shortcut');
    assert.ok(await page.evaluate(() => testMessages.some(m=>m.type==='OPEN_OPTIONS')),"settings click");
    console.log(`PASS ${checks} rendered layout checks, animation samples, settings lifecycle and click action`);
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1});
