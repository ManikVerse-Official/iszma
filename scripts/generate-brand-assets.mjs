import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve('ReportCard Studio/package.json'));
const { chromium } = require('playwright');

const primary = `data:image/png;base64,${readFileSync('public/logos/iszma-primary-logo.png').toString('base64')}`;
const stamp = `data:image/png;base64,${readFileSync('public/logos/iszma-stamp-logo.png').toString('base64')}`;

const browser = await chromium.launch({ channel: 'chrome' });

const iconSizes = [48, 180, 192, 512];
for (const size of iconSizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:100%;object-fit:contain}</style><img src="${primary}">`,
  );
  await page.screenshot({ path: `public/logos/iszma-icon-${size}.png`, omitBackground: true });
  await page.close();
  console.log(`wrote iszma-icon-${size}.png`);
}

const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await og.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden">
<div style="position:relative;width:1200px;height:630px;background:radial-gradient(circle at 78% 30%,#2a1650 0%,#0A0612 58%,#07040d 100%);font-family:'Segoe UI',Roboto,sans-serif;color:#f4f1ff;overflow:hidden">
  <div style="position:absolute;right:-210px;top:30px;width:600px;height:600px;background-image:url('${stamp}');background-size:contain;background-repeat:no-repeat;opacity:.10;filter:invert(1) sepia(1) saturate(5) hue-rotate(215deg)"></div>
  <div style="position:absolute;left:72px;top:74px;display:flex;align-items:center;gap:34px">
    <img src="${primary}" style="width:320px;height:320px;object-fit:contain;filter:drop-shadow(0 18px 48px rgba(139,92,246,.45))">
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:104px;line-height:1;font-weight:700;letter-spacing:-4px;background:linear-gradient(120deg,#ede9fe,#c4b5fd 45%,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent">isZma</div>
      <div style="font-size:25px;letter-spacing:10px;text-transform:uppercase;color:#c4b5fd">The Digital Mall</div>
    </div>
  </div>
  <div style="position:absolute;left:80px;bottom:78px;font-size:22px;letter-spacing:2px;color:#a39bc4">Tech · Art · Comics · Education</div>
  <div style="position:absolute;left:80px;bottom:44px;font-size:15px;letter-spacing:1px;color:#7c7496">Greeting cards · ReportCard Studio · Digital products</div>
</div></body></html>`);
await og.screenshot({ path: 'public/logos/iszma-og.png' });
await og.close();
console.log('wrote iszma-og.png');

await browser.close();
