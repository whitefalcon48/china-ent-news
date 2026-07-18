import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildReviewComment, type UiReviewDecision } from "./buildReviewComment.js";
import { checkGithubCli, fetchReviewData, runCommand, type ReviewUiData } from "./fetchReviewData.js";

const HOST = "127.0.0.1";
const PORT = parsePort(process.env.REVIEW_UI_PORT);
const DRY_RUN = process.argv.includes("--dry-run");
const SETUP_GUIDE = `GitHub CLI の準備が必要です（初回だけ）。
1. PowerShellで次を実行: winget install --id GitHub.cli
2. 新しいターミナルを開く
3. 次を実行: gh auth login
4. GitHub.com → HTTPS → ブラウザでログイン
5. 準備後に再実行: npm run review:ui`;

async function main() {
  if (!DRY_RUN) {
    const preflight = await checkGithubCli();
    if (!preflight.ready) {
      console.log(`${preflight.reason}\n\n${SETUP_GUIDE}`);
      return;
    }
  }

  const data = await fetchReviewData({ dryRun: DRY_RUN });
  const requestToken = randomBytes(24).toString("hex");
  const server = http.createServer((request, response) => handleRequest(request, response, data, requestToken));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  const url = `http://${HOST}:${PORT}/`;
  console.log(`レビューUI: ${url}`);
  console.log(DRY_RUN ? "dry-run: GitHubへは送信しません。" : "終了するにはこのターミナルで Ctrl+C を押してください。");
  if (process.env.REVIEW_UI_NO_OPEN !== "true") openBrowser(url);
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse, data: ReviewUiData, requestToken: string) {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (request.method === "GET" && url.pathname === "/") {
    send(response, 200, renderUi(data, requestToken), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/submit") {
    if (request.headers["x-review-ui-token"] !== requestToken) {
      sendJson(response, 403, { ok: false, error: "送信元を確認できませんでした。画面を再読み込みしてください。" });
      return;
    }
    try {
      const body = JSON.parse(await readBody(request)) as { date?: string; decisions?: UiReviewDecision[] };
      const day = data.days.find((item) => item.date === body.date);
      if (!day) throw new Error("レビュー対象日が見つかりません");
      const decisions = validateDecisions(body.decisions, day.review.articles.length);
      const comment = buildReviewComment(decisions);
      if (DRY_RUN) {
        sendJson(response, 200, { ok: true, dryRun: true, comment, issueUrl: day.issueUrl });
        return;
      }
      if (!day.issueNumber) throw new Error("レビューIssue番号がありません");
      const tempPath = path.join(os.tmpdir(), `china-ent-review-${process.pid}-${Date.now()}.txt`);
      await fs.writeFile(tempPath, comment, "utf8");
      try {
        await runCommand("gh", ["issue", "comment", String(day.issueNumber), "--body-file", tempPath]);
      } finally {
        await fs.rm(tempPath, { force: true });
      }
      sendJson(response, 200, { ok: true, dryRun: false, comment, issueUrl: day.issueUrl });
    } catch (error) {
      const fallback = safeFallbackComment(request);
      sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), ...fallback });
    }
    return;
  }
  send(response, 404, "Not found", "text/plain; charset=utf-8");
}

function validateDecisions(value: unknown, articleCount: number): UiReviewDecision[] {
  if (!Array.isArray(value) || !value.length) throw new Error("判定がありません");
  const allowedActions = new Set(["approved", "rejected", "revision_requested", "remaining_approved", "remaining_rejected"]);
  const allowedTags = new Set(["選定", "口調", "用語", "事実", "構成", "その他"]);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("判定形式が不正です");
    const decision = item as UiReviewDecision;
    if (!allowedActions.has(decision.action)) throw new Error("判定種別が不正です");
    if (!decision.action.startsWith("remaining_")) {
      if (!Number.isInteger(decision.index) || decision.index! < 1 || decision.index! > articleCount) throw new Error("記事番号が不正です");
    }
    if (decision.reasonTag && !allowedTags.has(decision.reasonTag)) throw new Error("理由タグが不正です");
    if (decision.action === "revision_requested" && !decision.comment?.trim()) throw new Error(`${decision.index}番の修正指示を入力してください`);
    return { ...decision, comment: decision.comment?.trim().slice(0, 1000) || "" };
  });
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new Error("送信内容が大きすぎます");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeFallbackComment(_request: http.IncomingMessage) {
  return { comment: "", issueUrl: "" };
}

function renderUi(data: ReviewUiData, requestToken: string) {
  const serialized = JSON.stringify({ data, requestToken }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>冰糖日报 レビュー</title><style>${UI_CSS}</style></head><body>
  <header class="top"><div><b>📋 冰糖日报 レビュー</b><select id="dateSelect" aria-label="レビュー日"></select></div><div class="progress"><span id="progressText"></span><i><b id="progressBar"></b></i></div><div class="top-actions"><button id="approveRest" class="soft">残りをすべて採用</button><button id="openConfirm" class="primary">送信 →</button></div></header>
  <main id="app"></main><div id="modal" class="modal" hidden></div>
  <script>const BOOT=${serialized};${UI_SCRIPT}</script></body></html>`;
}

function send(response: http.ServerResponse, status: number, body: string, contentType: string) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function openBrowser(url: string) {
  try {
    const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    console.log(`ブラウザを開けませんでした。手動で開いてください: ${url}`);
  }
}

function parsePort(value?: string) {
  const port = Number(value || 4989);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`REVIEW_UI_PORT が不正です: ${value}`);
  return port;
}

const UI_CSS = String.raw`
:root{--navy:#1f3043;--red:#c12b23;--ice:#eaf4fa;--ice2:#a7cddf;--paper:#fff;--bg:#f6fafc;--muted:#6e7e8c;--line:#dce8ef;--amber:#cd7019}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#283846;font-family:"Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;line-height:1.7}.top{position:sticky;z-index:5;top:0;background:rgba(255,255,255,.97);border-bottom:1px solid var(--line);padding:12px max(14px,calc((100% - 860px)/2));display:grid;grid-template-columns:1fr 1fr auto;align-items:center;gap:16px}.top b{color:var(--navy)}select,textarea,button{font:inherit}.top select{margin-left:12px;border:1px solid var(--line);border-radius:7px;padding:5px}.progress{font-size:.78rem;color:var(--muted)}.progress i{display:block;height:7px;background:var(--line);border-radius:9px;overflow:hidden}.progress i b{display:block;height:100%;background:var(--red);width:0}.top-actions{display:flex;gap:8px}button{border:0;border-radius:8px;padding:8px 13px;cursor:pointer;font-weight:700}.primary{background:var(--red);color:#fff}.soft{background:var(--ice);color:var(--navy)}main{width:min(820px,calc(100% - 24px));margin:26px auto 70px}.notice,.empty{border:1px solid var(--line);background:#fff;border-radius:12px;padding:16px;margin-bottom:18px;white-space:pre-wrap}.notice{border-color:#e7c28e;background:#fff8ed}.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 18px;box-shadow:0 1px 3px #1f304315}.card.active{outline:3px solid var(--ice2)}.meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.chip{font-size:.72rem;border-radius:99px;padding:2px 9px;background:#eee}.badge{background:var(--navy);color:#fff}.revision{background:#fff1de;color:#8a4b00}.card h2{font-size:1.08rem;line-height:1.55;margin:12px 0 8px}.lead{margin:0 0 12px}.details{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:8px 0;margin:12px 0}.details summary{cursor:pointer;color:var(--red);font-weight:700}.comment-box{background:var(--ice);border-radius:11px;padding:13px 15px;margin:12px 0}.comment-box h3{font-size:.82rem;color:var(--red);margin:0 0 4px}.comment-box p{margin:0 0 10px;white-space:pre-wrap}.sources{font-size:.78rem;color:var(--muted)}.sources a{color:var(--red);margin-right:8px}.decision-buttons{display:flex;gap:8px;margin-top:14px}.decision-buttons button{flex:1;background:#f1f4f6}.decision-buttons button.selected{background:var(--navy);color:white}.decision-buttons button.reject.selected{background:#8e2924}.editor{margin-top:12px;padding:12px;background:#faf8f5;border-radius:9px}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}.tags button{padding:4px 10px;background:#fff;border:1px solid #ddd}.tags button.selected{border-color:var(--red);color:var(--red);background:#fff2f0}.editor textarea{width:100%;min-height:70px;border:1px solid #ccd8df;border-radius:7px;padding:8px;resize:vertical}.previous{font-size:.82rem;color:#7a4a10;background:#fff5e8;border-radius:7px;padding:8px;margin:8px 0}.modal{position:fixed;z-index:20;inset:0;background:#172534aa;display:grid;place-items:center;padding:14px}.modal[hidden]{display:none}.dialog{width:min(680px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;padding:20px}.dialog h2{margin-top:0}.dialog textarea{width:100%;height:250px;padding:10px;font-family:Consolas,monospace}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.success{text-align:center;padding:30px}.success a{color:var(--red)}kbd{background:#eef1f3;border-radius:4px;padding:1px 5px;font-size:.75rem}@media(max-width:720px){.top{grid-template-columns:1fr;gap:8px}.top-actions button{flex:1}.card{padding:15px}.decision-buttons{flex-wrap:wrap}.decision-buttons button{min-width:28%}}
`;

const UI_SCRIPT = String.raw`
const TAGS=['選定','口調','用語','事実','構成','その他'];let dayIndex=0,current=0,states={};const app=document.getElementById('app'),modal=document.getElementById('modal'),dateSelect=document.getElementById('dateSelect');
function day(){return BOOT.data.days[dayIndex]}function key(){return day()?'bingtang-review-'+day().date:''}function load(){const d=day();if(!d)return;try{states=JSON.parse(localStorage.getItem(key())||'{}')}catch{states={}};for(const r of d.review.articles){if(states[r.index])continue;if(r.status==='approved')states[r.index]={action:'approved',tag:'その他',comment:''};if(r.status==='rejected')states[r.index]={action:'rejected',tag:r.reason_tag||'その他',comment:r.comment||''}}}
function save(){localStorage.setItem(key(),JSON.stringify(states));updateProgress()}function articleFor(r){return day().articles[r.index-1]||{raw:{title:r.title,category:'',reliability:''},summary:null}}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}function safeLink(url){try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:''}catch{return''}}
function render(){dateSelect.innerHTML='';BOOT.data.days.forEach((d,i)=>{const o=el('option','',d.date);o.value=String(i);dateSelect.append(o)});if(!day()){app.innerHTML='';app.append(el('div','empty','今日のレビューはありません。'));document.querySelector('.top-actions').hidden=true;updateProgress();return}document.querySelector('.top-actions').hidden=false;load();app.innerHTML='';if(BOOT.data.warning)app.append(el('div','notice',BOOT.data.warning));day().review.articles.forEach((r,pos)=>app.append(card(r,pos)));updateProgress()}
function card(r,pos){const a=articleFor(r),s=a.summary||{},c=el('article','card'+(pos===current?' active':''));c.id='article-'+r.index;const meta=el('div','meta');meta.append(el('span','chip badge',s.badge||'NEWS'),el('span','chip',s.category||a.raw.category||''),el('span','chip','確度'+(s.confidence||a.raw.reliability||'')));if(r.status==='revised_pending')meta.append(el('span','chip revision','🔄 修正版（'+r.revision_count+'回目）'));c.append(meta,el('h2','',s.title_ja||r.title||a.raw.title),el('p','lead',s.lead||''));if(r.status==='revised_pending')c.append(el('div','previous','前回の指示: '+(r.comment||'（指示なし）')));const details=el('details','details'),sum=el('summary','','何が起きた？');details.append(sum,el('p','',s.what_happened||''));c.append(details);const box=el('div','comment-box');box.append(el('h3','','ビンタンの注目ポイント'),el('p','',s.why_it_matters||''),el('h3','','ビンタンからのひとこと'),el('p','',s.editor_comment||''));c.append(box);const sources=el('div','sources','ソース: ');for(const src of (s.source_list||[])){const href=safeLink(src.url||'');if(href){const link=el('a','',src.name);link.href=href;link.target='_blank';link.rel='noreferrer';sources.append(link)}else sources.append(el('span','',src.name+' '))}c.append(sources);const buttons=el('div','decision-buttons');[['approved','✅ 採用',''],['revision_requested','✏️ 修正',''],['rejected','❌ 却下','reject']].forEach(([action,label,extra])=>{const b=el('button',extra,label);if(states[r.index]?.action===action)b.classList.add('selected');b.onclick=()=>setDecision(r.index,action);buttons.append(b)});c.append(buttons);if(['revision_requested','rejected'].includes(states[r.index]?.action))c.append(editor(r));return c}
function editor(r){const wrap=el('div','editor'),tags=el('div','tags');for(const tag of TAGS){const b=el('button',states[r.index]?.tag===tag?'selected':'',tag);b.onclick=()=>{states[r.index].tag=tag;save();render()};tags.append(b)}const ta=el('textarea');ta.placeholder=states[r.index].action==='revision_requested'?'短い修正指示（例: 口調が硬い。要するに構造で）':'コメント（任意）';ta.value=states[r.index].comment||'';ta.oninput=()=>{states[r.index].comment=ta.value;save()};wrap.append(tags,ta);return wrap}
function setDecision(index,action){const old=states[index]||{};states[index]={action,tag:old.tag||'その他',comment:old.comment||''};save();render();if(action==='approved')focusIndex(Math.min(day().review.articles.length-1,current+1))}function focusIndex(i){current=Math.max(0,Math.min(day().review.articles.length-1,i));render();document.getElementById('article-'+day().review.articles[current].index)?.scrollIntoView({behavior:'smooth',block:'center'})}
function updateProgress(){const total=day()?.review.articles.length||0,done=day()?day().review.articles.filter(r=>states[r.index]?.action).length:0;document.getElementById('progressText').textContent='判定済み '+done+'/'+total;document.getElementById('progressBar').style.width=(total?done/total*100:0)+'%'}
function decisions(){return day().review.articles.map(r=>states[r.index]?{index:r.index,action:states[r.index].action,reasonTag:states[r.index].tag,comment:states[r.index].comment}:null).filter(Boolean)}function commentText(ds){return ds.map(d=>d.action==='approved'?d.index+' 採用':d.index+' '+(d.action==='rejected'?'却下':'修正')+' '+(d.reasonTag||'その他')+(d.comment?.trim()?' '+d.comment.trim():'')).join('\n')}
function validate(){const missing=day().review.articles.filter(r=>!states[r.index]);if(missing.length)return '未判定の記事があります: '+missing.map(r=>r.index).join(', ');const noInstruction=day().review.articles.filter(r=>states[r.index]?.action==='revision_requested'&&!states[r.index]?.comment?.trim());if(noInstruction.length)return '修正指示を入力してください: '+noInstruction.map(r=>r.index).join(', ');return''}
function confirm(){const error=validate();if(error){alert(error);return}const ds=decisions(),text=commentText(ds),counts={approved:0,revision_requested:0,rejected:0};ds.forEach(d=>counts[d.action]++);modal.hidden=false;modal.innerHTML='';const d=el('div','dialog');d.append(el('h2','','送信内容の確認'),el('p','','採用 '+counts.approved+'・修正 '+counts.revision_requested+'・却下 '+counts.rejected));const ta=el('textarea');ta.readOnly=true;ta.value=text;d.append(ta);const actions=el('div','dialog-actions'),cancel=el('button','soft','戻る'),copy=el('button','soft','コピー'),submit=el('button','primary','送信する');cancel.onclick=()=>modal.hidden=true;copy.onclick=()=>copyText(text,ta);submit.onclick=()=>submitReview(ds,text,submit);actions.append(cancel,copy,submit);d.append(actions);modal.append(d)}
async function submitReview(ds,text,button){button.disabled=true;button.textContent='送信中…';let result;try{const res=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json','x-review-ui-token':BOOT.requestToken},body:JSON.stringify({date:day().date,decisions:ds})});result=await res.json()}catch(e){result={ok:false,error:String(e),comment:text,issueUrl:day().issueUrl}}if(result.ok){localStorage.removeItem(key());success(result)}else{failure(result,text)} }
function success(result){modal.innerHTML='';const d=el('div','dialog success');d.append(el('h2','',result.dryRun?'dry-run 完了':'送信しました！'),el('p','',result.dryRun?'GitHubには送信していません。下のコメント文法を確認できます。':'GitHub Actionsの review-apply が自動で始まります。修正記事がある場合は、再生成後にもう一度 review:ui を起動してください。'));const ta=el('textarea');ta.readOnly=true;ta.value=result.comment;d.append(ta);if(result.issueUrl){const a=el('a','','Issueを開く');a.href=result.issueUrl;a.target='_blank';d.append(a)}modal.append(d)}
function failure(result,text){modal.innerHTML='';const d=el('div','dialog');d.append(el('h2','','送信できませんでした'),el('p','',result.error||'不明なエラー'),el('p','','下の内容をコピーしてIssueへ貼り付けてください。'));const ta=el('textarea');ta.readOnly=true;ta.value=result.comment||text;d.append(ta);const actions=el('div','dialog-actions'),copy=el('button','soft','コメントをコピー');copy.onclick=()=>copyText(ta.value,ta);actions.append(copy);if(result.issueUrl||day().issueUrl){const a=el('a','primary','Issueを開く');a.href=result.issueUrl||day().issueUrl;a.target='_blank';actions.append(a)}d.append(actions);modal.append(d)}
async function copyText(text,ta){try{await navigator.clipboard.writeText(text)}catch{ta.focus();ta.select();document.execCommand('copy')}}
dateSelect.onchange=()=>{dayIndex=Number(dateSelect.value);current=0;states={};render()};document.getElementById('approveRest').onclick=()=>{for(const r of day().review.articles)if(!states[r.index])states[r.index]={action:'approved',tag:'その他',comment:''};save();render()};document.getElementById('openConfirm').onclick=confirm;
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();confirm();return}if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;const r=day()?.review.articles[current];if(!r)return;if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();focusIndex(current+1)}if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();focusIndex(current-1)}if(e.key==='a')setDecision(r.index,'approved');if(e.key==='e')setDecision(r.index,'revision_requested');if(e.key==='x')setDecision(r.index,'rejected');if(e.key==='z')document.getElementById('approveRest').click();if(/^[1-6]$/.test(e.key)&&states[r.index]&&['revision_requested','rejected'].includes(states[r.index].action)){states[r.index].tag=TAGS[Number(e.key)-1];save();render()}if(e.key==='Enter')focusIndex(current+1)});render();
`;

main().catch((error) => {
  console.error(`review UI failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
