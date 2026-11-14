// 실행: node harness/backup-pass.e2e.mjs
// 백업 암호를 기기가 기억한다(beta.59, 사용자 결정 2026-11-15) — 계약:
//   ① 처음 백업할 때 한 번만 정한다(두 번 입력) → "종이에 적어 주세요" 창이 암호를 크게 보여 준다
//   ② 그 뒤 [지금 백업하기]는 암호를 묻지 않는다 — 그래도 파일은 같은 암호로 잠겨 있다(Node에서 직접 풀어 확인)
//   ③ 기억한 암호·검증자는 백업 파일에 실리지 않는다
//   ④ "암호 없이 파일 만들기" 길은 남아 있다(선택창 아래 글씨 → 확인 창, 진한 버튼은 [취소])
//   ⑤ [백업 암호]로 바꾸면 새 암호를 다시 적게 하고, 다음 백업은 새 암호로 잠긴다
//   ⑥ 예전 버전에서 암호만 정해 둔 기기(기억 없음)는 한 번만 넣으면 그 뒤로 묻지 않는다(틀리면 창 안에 사유)
//   ⑦ 새 기기에서 암호 건 파일로 되찾으면 그 암호가 그 기기의 백업 암호가 된다(다음 백업에서 묻지 않음)
//   ⑧ 장부 지키기 카드와 백업 확인 창에 "종이에 적어 보관" 안내가 보인다
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; const file = p === '/' ? '/index.html' : p;
  try {
    const body = readFileSync(ROOT + decodeURIComponent(file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port + '/';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const PW1 = '20261115', PW2 = 'bapjang-2027';

// 암호 건 백업 파일을 앱 없이 푼다 — 맞으면 안쪽 객체, 틀리면 null.
function openPassFile(text, pw) {
  let f; try { f = JSON.parse(text); } catch { return null; }
  if (!f || f.type !== 'prepaid-pass-backup') return null;
  try {
    const key = pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(f.kdf.salt, 'base64'), f.kdf.it, 32, 'sha256');
    const ct = Buffer.from(f.ct, 'base64'); const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    let pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    if (Number(f.z) === 1) pt = gunzipSync(pt);
    return JSON.parse(pt.toString('utf8'));
  } catch { return null; }
}

const browser = await chromium.launch();
async function newDevice() {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"internal"}' }));
  const page = await ctx.newPage();
  const errors = [], dialogs = [], files = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message().slice(0, 80)); d.accept().catch(() => {}); });
  page.on('download', async d => { try { files.push({ name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') }); } catch (e) { files.push({ name: 'ERR', text: '' }); } });
  const pin = async () => { for (const k of '1234') { await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click(); await page.waitForTimeout(300); } };
  const meta = keys => page.evaluate(ks => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const out = {}; r.result.transaction('meta').objectStore('meta').openCursor().onsuccess = e => { const c = e.target.result; if (c) { if (ks.includes(c.value.key)) out[c.value.key] = c.value.value; c.continue(); } else res(out); }; }; }), keys);
  const waitFile = async n => { const t0 = Date.now(); while (files.length < n && Date.now() - t0 < 20000) await page.waitForTimeout(100); return files[n - 1]; };
  const choiceText = async () => (await page.locator('.choice-modal').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const pick = async v => { await page.locator(`.choice-modal [data-a="choice-pick"][data-val="${v}"]`).click(); await page.waitForTimeout(250); };
  const goGuard = async () => {
    await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForSelector('.fold-head');
    const h = page.locator('.fold-head[data-card="ledger"]'); if ((await h.getAttribute('aria-expanded')) === 'false') await h.click();
    await page.waitForSelector('[data-a="backup-now"]');
  };
  return { ctx, page, errors, dialogs, files, pin, meta, waitFile, choiceText, pick, goGuard };
}
async function setupDirect(d) {
  const { page, pin } = d;
  await page.goto(base); await page.waitForSelector('[data-a="setup-welcome-start"]');
  await page.click('[data-a="setup-welcome-start"]'); await page.waitForSelector('#setupStoreName');
  await page.click('[data-a="setup-manual-toggle"]');
  await page.fill('#setupManualName', '암호기억식당'); await page.fill('#setupManualAddr', '서울특별시 광진구 구의동 123-45');
  await page.click('[data-a="setup-manual-save"]'); await page.click('[data-a="setup-next"]');
  await page.waitForSelector('[data-a="setup-to-contact"]'); await page.click('[data-a="setup-to-contact"]');
  await page.waitForSelector('#setupTermsChk'); await page.check('#setupTermsChk'); await page.click('[data-a="setup-contact-skip"]');
  await page.waitForSelector('[data-a="pin-key"]'); await pin(); await page.waitForTimeout(400); await pin();
  await page.waitForFunction(() => !document.querySelector('.pin-screen'), null, { timeout: 20000 }); await page.waitForTimeout(1000);
  if (await page.locator('[data-a="guide-dismiss"]').count()) await page.locator('[data-a="guide-dismiss"]').click();
  await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForSelector('.fold-head');
  await page.locator('.fold-head[data-card="enroll-manual"]').click(); await page.waitForSelector('[data-a="add-employee"]'); await page.click('[data-a="add-employee"]');
  await page.fill('#empDept', '총무과'); await page.fill('#empName', '홍길동'); await page.fill('#empOpen', '30000'); await page.click('[data-a="save-employee"]'); await page.waitForTimeout(500);
}

// ═══ 기기 A: 처음 정하기 → 기억 → 다시 묻지 않기 → 암호 없이 → 바꾸기 → 예전 기기(기억 없음) ═══
const A = await newDevice();
await setupDirect(A);
{
  const { page, files, meta, waitFile, choiceText, pick, goGuard } = A;
  await goGuard();
  ok((await page.locator('#guardPassNote').count()) === 0, '카드: 암호를 정하기 전에는 "종이에 적어 보관" 줄이 없다');
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal');
  ok(!(await choiceText()).includes('암호 없이 파일 만들기'), '처음: 선택창에 "암호 없이 파일 만들기" 글씨가 없다(암호 창 안의 체크로 고른다 — 예전과 같음)');
  await pick('save'); await page.waitForSelector('#keyPass1');
  let help = (await page.locator('.pass-modal').innerText()).replace(/\s+/g, ' ');
  ok((await page.locator('#keyPass2').count()) === 1 && help.includes('종이에 꼭 적어 두세요') && help.includes('새 태블릿에서 되찾을 때 필요해요') && help.includes('평소에는 다시 묻지 않아요'),
    '처음: 암호 정하기 창(두 번 입력)에 "종이에 꼭 적어 두세요 · 새 태블릿에서 되찾을 때 필요 · 평소에는 다시 묻지 않아요" — ' + JSON.stringify(help.slice(0, 150)));
  await page.fill('#keyPass1', PW1); await page.fill('#keyPass2', PW1); await page.click('[data-a="pass-ok"]');
  const wrote = await page.waitForSelector('.choice-modal #passWrite', { timeout: 20000 }).then(() => true, () => false);
  let t = await choiceText();
  ok(wrote && (await page.locator('#passWrite').innerText()).trim() === PW1 && t.includes('종이에 적어 주세요') && t.includes('새 태블릿에서 장부를 되찾을 때 이 암호가 꼭 필요해요') && t.includes('아무도(운영자도)'),
    '처음: 정한 직후 "백업 암호를 종이에 적어 주세요" 창이 암호를 그대로 크게 보여 준다');
  ok((await page.locator('.choice-modal [data-a="choice-pick"]').count()) === 1 && (await page.locator('.choice-modal .btn-primary').innerText()).includes('종이에 적어 두었어요'), '처음: 그 창의 버튼은 [종이에 적어 두었어요] 하나');
  ok(files.length === 0, '처음: 적어 두었다고 누르기 전에는 파일을 만들지 않는다');
  await pick('ok');
  const f1 = await waitFile(1);
  await page.waitForSelector('.choice-modal');
  t = await choiceText();
  ok(t.includes('파일이 저장됐나요') && t.includes('이 파일은 백업 암호로 열려요') && t.includes('암호를 적어 둔 종이를 잘 보관해 주세요'), '처음: "파일이 저장됐나요?" 창에 "백업 암호로 열려요 · 적어 둔 종이 보관" 한 줄');
  await pick('yes');
  const in1 = f1 && openPassFile(f1.text, PW1);
  ok(!!in1 && in1.core && Array.isArray(in1.core.payload.employees) && in1.core.payload.employees.length === 1, '처음: 내려받은 파일은 정한 암호로 열린다(직원 1명)');
  const m1 = await meta(['backupPassCheck', 'backupPassKeep']);
  ok(!!(m1.backupPassCheck && m1.backupPassCheck.hash) && typeof m1.backupPassKeep === 'string' && m1.backupPassKeep.length > 20 && !m1.backupPassKeep.includes(PW1), '처음: 기기에 검증자와 "기억한 암호(잠근 사본)"가 남는다 — 평문은 저장하지 않음');
  ok(!!f1 && !f1.text.includes('backupPassKeep') && !!in1 && !JSON.stringify(in1).includes('backupPassKeep') && !JSON.stringify(in1).includes('backupPassCheck'), '처음: 백업 파일 안팎에 기억한 암호·검증자가 실리지 않는다');
  ok((await page.locator('#guardPassNote').count()) === 1 && (await page.locator('#guardPassNote').innerText()).includes('백업 암호는 종이에 적어 보관하세요'), '카드: 암호를 정한 뒤에는 "백업 암호는 종이에 적어 보관하세요" 줄이 늘 보인다');
  const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  ok(fit.sw <= fit.iw, '카드: 가로 넘침 없음(412폭) — ' + JSON.stringify(fit));

  // ② 두 번째부터는 묻지 않는다
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal');
  ok((await choiceText()).includes('암호 없이 파일 만들기'), '두 번째: 선택창 아래에 "암호 없이 파일 만들기" 글씨가 있다(암호 창이 뜨지 않으므로 그 길을 여기에 둠)');
  ok((await page.locator('.choice-modal .choice-actions [data-a="choice-pick"]').count()) === 3 && (await page.locator('.choice-modal .btn-primary').count()) === 1, '두 번째: 버튼은 여전히 세 갈래, 진한 버튼 하나');
  await pick('save');
  const f2 = await waitFile(2);
  ok((await page.locator('#keyPass1').count()) === 0 && !!f2, '두 번째: 암호 창이 뜨지 않고 곧바로 파일이 만들어진다');
  await page.waitForSelector('.choice-modal'); await pick('yes');
  ok(!!f2 && !!openPassFile(f2.text, PW1) && !openPassFile(f2.text, 'wrong-pass-1'), '두 번째: 그 파일도 같은 암호로 잠겨 있다(다른 암호로는 안 열림)');

  // ④ 암호 없이
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal'); await pick('plain');
  t = await choiceText();
  ok(t.includes('암호 없이 만들까요') && t.includes('파일을 연 사람 누구나') && t.includes('가게 열쇠는 들어가지 않아요') && (await page.locator('.choice-modal .btn-primary').innerText()).includes('취소'),
    '암호 없이: 확인 창이 위험을 말하고 진한 버튼은 [취소]');
  await pick('none'); await page.waitForTimeout(300);
  ok(files.length === 2, '암호 없이: [취소]면 파일을 만들지 않는다');
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal'); await pick('plain'); await pick('save');
  const f3 = await waitFile(3);
  await page.waitForSelector('.choice-modal');
  ok(!(await choiceText()).includes('백업 암호로 열려요'), '암호 없이: 확인 창에 "백업 암호로 열려요" 줄이 없다');
  await pick('yes');
  let plainObj = null; try { plainObj = JSON.parse(f3.text); } catch {}
  ok(!!plainObj && plainObj.schemaVersion === 3 && plainObj.type !== 'prepaid-pass-backup' && !f3.text.includes('backupPassKeep') && !f3.text.includes('backupPassCheck'), '암호 없이: 평문 백업(예전 형식)이 만들어지고 기억한 암호·검증자는 없다');

  // ⑤ 바꾸기
  await page.click('[data-a="backup-pass"]'); await page.waitForSelector('#keyPass1');
  help = (await page.locator('.pass-modal').innerText()).replace(/\s+/g, ' ');
  ok(help.includes('새 암호도 종이에 꼭 적어 두세요') && help.includes('예전에 만든 백업 파일은 예전 암호로 열려요'), '바꾸기: 창에 "새 암호도 종이에 꼭 적어 두세요 · 예전 파일은 예전 암호"');
  await page.fill('#keyPass1', PW2); await page.fill('#keyPass2', PW2); await page.click('[data-a="pass-ok"]');
  await page.waitForSelector('.choice-modal #passWrite', { timeout: 20000 });
  t = await choiceText();
  ok((await page.locator('#passWrite').innerText()).trim() === PW2 && t.includes('새 백업 암호를 종이에 적어 주세요') && t.includes('예전에 만든 백업 파일은 예전 암호로 열려요'), '바꾸기: 새 암호를 다시 크게 보여 주고 적게 한다');
  await pick('ok');
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal'); await pick('save');
  const f4 = await waitFile(4);
  ok((await page.locator('#keyPass1').count()) === 0 && !!f4 && !!openPassFile(f4.text, PW2) && !openPassFile(f4.text, PW1), '바꾸기: 다음 백업은 묻지 않고 새 암호로 잠긴다(예전 암호로는 안 열림)');
  await page.waitForSelector('.choice-modal'); await pick('yes');

  // ⑥ 예전 버전에서 암호만 정해 둔 기기(기억 없음) — 한 번만 넣으면 된다
  await page.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('backupPassKeep'); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }; }));
  await page.reload(); await page.waitForSelector('.cust-screen, [data-a="pin-key"]');
  if (await page.locator('[data-a="lock-to-pin"]').count()) { await page.locator('[data-a="lock-to-pin"]').click(); await page.waitForSelector('[data-a="pin-key"]'); }
  await A.pin(); await page.waitForFunction(() => !document.querySelector('.pin-screen') && !document.querySelector('.cust-screen'), null, { timeout: 15000 });
  await goGuard();
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal');
  ok(!(await choiceText()).includes('암호 없이 파일 만들기'), '예전 기기: 아직 기억한 암호가 없으면 선택창은 예전 그대로다');
  await pick('save'); await page.waitForSelector('#keyPass1');
  help = (await page.locator('.pass-modal').innerText()).replace(/\s+/g, ' ');
  ok((await page.locator('#keyPass2').count()) === 0 && help.includes('이번 한 번만') && help.includes('다음부터는 묻지 않아요'), '예전 기기: 암호 창(한 번 입력)이 "이번 한 번만 넣으면 다음부터는 묻지 않아요"라고 말한다');
  await page.fill('#keyPass1', 'not-the-pass'); await page.click('[data-a="pass-ok"]');
  await page.waitForFunction(() => /암호가 맞지 않아요/.test((document.querySelector('#keyPassHint') || {}).textContent || ''), null, { timeout: 20000 }).catch(() => {});
  ok((await page.locator('#keyPassHint').innerText()).includes('암호가 맞지 않아요') && files.length === 4 && !(await meta(['backupPassKeep'])).backupPassKeep, '예전 기기: 틀린 암호는 창 안에 사유가 남고, 기억하지도 파일을 만들지도 않는다');
  await page.fill('#keyPass1', PW2); await page.click('[data-a="pass-ok"]');
  const f5 = await waitFile(5);
  ok(!!f5 && !!openPassFile(f5.text, PW2) && (await page.locator('#passWrite').count()) === 0, '예전 기기: 맞는 암호를 한 번 넣으면 파일이 만들어진다(이미 정한 암호라 적어 두기 창은 다시 띄우지 않음)');
  await page.waitForSelector('.choice-modal'); await pick('yes');
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal'); await pick('save');
  const f6 = await waitFile(6);
  ok((await page.locator('#keyPass1').count()) === 0 && !!f6 && !!openPassFile(f6.text, PW2), '예전 기기: 그다음 백업부터는 묻지 않는다');
  await page.waitForSelector('.choice-modal'); await pick('yes');
  ok(A.errors.length === 0 && A.dialogs.length === 0, '기기 A: 페이지 예외·기본 팝업 없음' + (A.errors[0] ? ' — ' + A.errors[0] : '') + (A.dialogs[0] ? ' — ' + A.dialogs[0] : ''));
}

// ═══ 기기 B: 새 태블릿에서 암호 건 파일로 되찾으면 그 암호를 기억한다 ═══
{
  const passFileText = A.files[5].text;
  const B = await newDevice(); const { page, meta, waitFile, pick, goGuard } = B;
  await page.goto(base); await page.waitForSelector('[data-a="setup-welcome-start"]');
  await page.click('[data-a="setup-welcome-start"]'); await page.waitForSelector('#setupStoreName'); await page.click('[data-a="setup-manual-toggle"]'); await page.waitForSelector('#setupManualName');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.click('[data-a="welcome-restore"]')]);
  await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(passFileText, 'utf8') });
  await page.waitForSelector('#keyPass1', { timeout: 10000 });
  await page.fill('#keyPass1', PW2); await page.click('[data-a="pass-ok"]');
  // 되찾기 확인(비교 창 → 결과 창)을 끝까지 따라간다 — 창마다 진한 버튼이 "계속"이다(줄어드는 복원이 아니므로).
  for (let i = 0; i < 6; i++) {
    const got = await page.waitForSelector('.choice-modal, [data-a="pin-key"]', { timeout: 20000 }).then(() => true, () => false);
    if (!got || !(await page.locator('.choice-modal').count())) break;
    await page.locator('.choice-modal .btn-primary').first().click(); await page.waitForTimeout(500);
  }
  await page.waitForSelector('[data-a="pin-key"]', { timeout: 20000 });
  await B.pin(); await page.waitForTimeout(400); await B.pin();
  await page.waitForFunction(() => !document.querySelector('.pin-screen') && !document.querySelector('.cust-screen'), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  if (await page.locator('[data-a="guide-dismiss"]').count()) await page.locator('[data-a="guide-dismiss"]').click();
  const mb = await meta(['backupPassCheck', 'backupPassKeep', 'shopName']);
  ok(mb.shopName === '암호기억식당' && !!(mb.backupPassCheck && mb.backupPassCheck.hash) && typeof mb.backupPassKeep === 'string' && mb.backupPassKeep.length > 20, '새 기기: 되찾으면 파일을 연 암호가 이 기기의 백업 암호로 기억된다 — ' + JSON.stringify({ shop: mb.shopName, keep: !!mb.backupPassKeep }));
  await goGuard();
  ok((await page.locator('#guardPassNote').count()) === 1, '새 기기: 카드에 "백업 암호는 종이에 적어 보관하세요" 줄이 보인다');
  await page.click('[data-a="backup-now"]'); await page.waitForSelector('.choice-modal'); await pick('save');
  const fb = await waitFile(1);
  ok((await page.locator('#keyPass1').count()) === 0 && !!fb && !!openPassFile(fb.text, PW2), '새 기기: 다음 백업은 암호를 묻지 않고 같은 암호로 잠긴다');
  ok(B.errors.length === 0, '기기 B: 페이지 예외 없음' + (B.errors[0] ? ' — ' + B.errors[0] : ''));
  await B.ctx.close();
}
await A.ctx.close();
await browser.close();
srv.close();
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
