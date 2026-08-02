import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { appendSelectionFeedback, applyCandidateRatings, candidateReviewPath, readCandidateReviewState, selectionFeedbackPath, writeCandidateReviewState } from "./candidateReviewState.js";
import { candidateInterestLabels, candidateReasonTags, type CandidateRatingDecision, type CandidateReviewState } from "./candidateReviewTypes.js";

const HOST = "127.0.0.1";
const PORT = parsePort(process.env.PREFERENCE_UI_PORT || "4990");
const DATA_DIR = path.resolve(process.env.SITE_DATA_DIR || "data");

type Day = { date: string; review: CandidateReviewState };

async function main() {
  const days = await loadDays();
  const token = randomBytes(24).toString("hex");
  const server = http.createServer((request, response) => handle(request, response, days, token));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(PORT, HOST, resolve); });
  const url = `http://${HOST}:${PORT}/`;
  console.log(`候補レビューUI: ${url}`);
  console.log("公開判定は行いません。終了するには Ctrl+C を押してください。");
  if (process.env.PREFERENCE_UI_NO_OPEN !== "true") openBrowser(url);
}

async function loadDays(): Promise<Day[]> {
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(DATA_DIR, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const days: Day[] = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    try {
      const review = await readCandidateReviewState(candidateReviewPath(DATA_DIR, entry.name));
      if (review.status === "pending") days.push({ date: entry.name, review });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`候補レビューUI警告 (${entry.name}): ${String(error)}`);
    }
  }
  return days.sort((left, right) => right.date.localeCompare(left.date));
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse, days: Day[], token: string) {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (request.method === "GET" && url.pathname === "/") return send(response, 200, render(days, token), "text/html; charset=utf-8");
  if (request.method !== "POST" || url.pathname !== "/submit") return send(response, 404, "Not found", "text/plain; charset=utf-8");
  if (request.headers["x-preference-ui-token"] !== token) return sendJson(response, 403, { ok: false, error: "画面を再読み込みしてください。" });
  try {
    const body = JSON.parse(await readBody(request)) as { date?: string; decisions?: CandidateRatingDecision[] };
    const day = days.find((item) => item.date === body.date);
    if (!day) throw new Error("候補レビュー対象日が見つかりません");
    const statePath = candidateReviewPath(DATA_DIR, day.date);
    const applied = applyCandidateRatings(await readCandidateReviewState(statePath), body.decisions ?? []);
    await writeCandidateReviewState(statePath, applied.state);
    await appendSelectionFeedback(selectionFeedbackPath(DATA_DIR), applied.feedback);
    sendJson(response, 200, { ok: true, rated: applied.feedback.length });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 256 * 1024) throw new Error("送信内容が大きすぎます"); chunks.push(buffer); }
  return Buffer.concat(chunks).toString("utf8");
}

function render(days: Day[], token: string) {
  const boot = JSON.stringify({ days, token, labels: candidateInterestLabels, tags: candidateReasonTags }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>冰糖日报 候補レビュー</title><style>${CSS}</style><body><header><b>🔎 冰糖日报 候補レビュー</b><span>公開判定には使いません</span><select id="date"></select><button id="submit">評価を保存</button></header><main id="app"></main><script>const BOOT=${boot};${SCRIPT}</script></body></html>`;
}

function send(response: http.ServerResponse, status: number, body: string, contentType: string) { response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(body); }
function sendJson(response: http.ServerResponse, status: number, value: unknown) { send(response, status, JSON.stringify(value), "application/json; charset=utf-8"); }
function parsePort(value: string) { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`PREFERENCE_UI_PORT が不正です: ${value}`); return port; }
function openBrowser(url: string) { try { const child = spawn(process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open", process.platform === "win32" ? ["/c", "start", "", url] : [url], { detached: true, stdio: "ignore", windowsHide: true }); child.unref(); } catch { console.log(`手動で開いてください: ${url}`); } }

const CSS = String.raw`body{margin:0;background:#f6fafc;color:#283846;font:16px/1.65 "Yu Gothic UI",Meiryo,sans-serif}header{position:sticky;top:0;background:#fffffff5;border-bottom:1px solid #dce8ef;padding:12px max(14px,calc((100% - 900px)/2));display:flex;gap:12px;align-items:center}header b{color:#1f3043}header span{font-size:.8em;color:#6e7e8c}select,button,textarea,input{font:inherit}button{border:0;border-radius:8px;background:#c12b23;color:#fff;padding:8px 13px;font-weight:bold;cursor:pointer}select{border:1px solid #dce8ef;border-radius:7px;padding:5px}main{max-width:860px;margin:24px auto;padding:0 12px}.notice,.card{background:#fff;border:1px solid #dce8ef;border-radius:13px;padding:16px;margin-bottom:16px}.notice{background:#fff8ed}.meta,.rates,.tags{display:flex;gap:7px;flex-wrap:wrap}.chip{font-size:.75em;background:#edf1f4;border-radius:99px;padding:2px 8px}.high{background:#fff0ee;color:#8e2924}.medium{background:#fff4dd;color:#8a5200}h2{font-size:1.08em;margin:9px 0}.evidence{font-size:.83em;color:#6e7e8c;border-block:1px solid #dce8ef;padding:8px 0}.rates{margin-top:12px}.rates button,.tags button{color:#283846;background:#fff;border:1px solid #cbd8df;padding:6px 9px}.rates button.selected{background:#1f3043;color:#fff}.tags button.selected{border-color:#c12b23;color:#c12b23;background:#fff2f0}.details{display:none;margin-top:12px;padding:12px;background:#eaf4fa;border-radius:9px}.details.show{display:block}.details textarea,.details input{width:100%;border:1px solid #cbd8df;border-radius:7px;padding:8px;margin-top:8px}.details textarea{min-height:65px}@media(max-width:650px){header{flex-wrap:wrap}header b{width:100%}}`;

const SCRIPT = String.raw`let ix=0,states={};const app=document.getElementById('app'),sel=document.getElementById('date');function day(){return BOOT.days[ix]}function key(){return day()?'candidate-review-'+day().date:''}function el(t,c,x){const n=document.createElement(t);if(c)n.className=c;if(x!==undefined)n.textContent=x;return n}function load(){try{states=JSON.parse(localStorage.getItem(key())||'{}')}catch{states={}}}function save(){localStorage.setItem(key(),JSON.stringify(states))}function render(){sel.innerHTML='';BOOT.days.forEach((d,i)=>{const o=el('option','',d.date);o.value=i;sel.append(o)});if(!day()){app.innerHTML='';app.append(el('div','notice','未評価の候補レビューはありません。先に npm run preference:prepare -- YYYY-MM-DD を実行してください。'));document.getElementById('submit').hidden=true;return}document.getElementById('submit').hidden=false;load();app.innerHTML='';app.append(el('div','notice','関心がある候補だけ評価してください。未評価は保存も学習もされず、「興味なし」扱いにはなりません。'));day().review.candidates.forEach(c=>app.append(card(c)))}function card(c){const s=states[c.index]||{},n=el('article','card'),meta=el('div','meta');meta.append(el('span','chip','#'+c.baseline_rank),el('span','chip',c.topic_type),el('span','chip '+(c.risk_class==='high'?'high':c.risk_class==='medium'?'medium':''),'根拠確認 '+c.risk_class));(c.interest_features||[]).forEach(f=>meta.append(el('span','chip',f)));n.append(meta,el('h2','',c.title),el('p','',c.event_sentence||'（出来事の要約なし）'),el('div','evidence','根拠: '+c.source_count+'件 / '+(c.source_names||[]).join('・')+(c.caution_note?' / 注意: '+c.caution_note:''));const rates=el('div','rates');[5,4,3,2,1].forEach(r=>{const b=el('button',s.rating===r?'selected':'',r+' '+BOOT.labels[r]);b.onclick=()=>{states[c.index]={...s,rating:r};save();render()};rates.append(b)});n.append(rates);const d=el('div','details'+(s.rating?' show':'')),tags=el('div','tags');BOOT.tags.forEach(tag=>{const b=el('button',(s.tags||[]).includes(tag)?'selected':'',tag);b.onclick=()=>{const q=states[c.index]||{},set=new Set(q.tags||[]);set.has(tag)?set.delete(tag):set.add(tag);states[c.index]={...q,tags:[...set]};save();render()};tags.append(b)});const note=el('textarea');note.placeholder='メモ（任意）';note.value=s.note||'';note.oninput=()=>{states[c.index]={...(states[c.index]||{}),note:note.value};save()};const similar=el('input');similar.placeholder='似た話題・追いたいテーマ（任意、カンマ区切り）';similar.value=s.similar||'';similar.oninput=()=>{states[c.index]={...(states[c.index]||{}),similar:similar.value};save()};d.append(tags,note,similar);n.append(d);return n}function decisions(){return day().review.candidates.map(c=>{const s=states[c.index];return s&&s.rating?{index:c.index,rating:s.rating,reasonTags:s.tags||[],note:s.note||'',similarTopics:(s.similar||'').split(',').map(v=>v.trim()).filter(Boolean)}:null}).filter(Boolean)}async function submit(){const ds=decisions();if(!ds.length)return alert('関心度を付けた候補がありません。');if(!confirm('評価済み '+ds.length+'件だけを保存します。未評価は負例になりません。'))return;const res=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json','x-preference-ui-token':BOOT.token},body:JSON.stringify({date:day().date,decisions:ds})}),out=await res.json();if(!out.ok)return alert(out.error||'保存できませんでした');localStorage.removeItem(key());alert('評価 '+out.rated+'件を保存しました。公開承認ではありません。');location.reload()}sel.onchange=()=>{ix=Number(sel.value);states={};render()};document.getElementById('submit').onclick=submit;render();`;

main().catch((error) => { console.error(`候補レビューUIに失敗しました: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
