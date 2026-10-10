// Per-run in-memory fixture: no business site or disk database.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createUxSut() {
let v2 = false; // 改版开关：「新建订单」→「创建订单」
const orders = [{ id: 1, customer: "华东分公司", amount: 1200 }, { id: 2, customer: "华南分公司", amount: 860 }];
const shell = (title, body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:15px system-ui,sans-serif}header{position:sticky;top:0;height:52px;background:#1e3a8a;color:#fff;
display:flex;align-items:center;justify-content:space-between;padding:0 16px}header input{width:260px;padding:4px 8px}
main{padding:24px}table{border-collapse:collapse;margin-top:12px}td,th{border:1px solid #ccc;padding:6px 12px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center}
.modal>div{background:#fff;padding:24px;border-radius:8px;display:grid;gap:8px;min-width:320px}</style></head><body>${body}</body></html>`;
const loginPage = shell("登录 - 订单管理", `
<header><b>订单管理系统</b><span></span><span></span></header>
<main><h1>登录</h1>
<label>账号 <input id="u" aria-label="账号"></label><br><br>
<label>密码 <input id="p" type="password" aria-label="密码"></label><br><br>
<button id="login">登录</button><p id="msg" role="status"></p></main>
<script>
document.getElementById("login").onclick = async () => {
  if (!document.getElementById("u").value) { document.getElementById("msg").textContent = "请输入账号"; return; }
  await fetch("/api/login", { method: "POST" });
  localStorage.setItem("token", "t-" + Date.now());
  location.href = "/app";
};
</script>`);
const appPage = () => shell("订单列表 - 订单管理", `
<header><b>订单管理系统</b><input placeholder="搜索订单号 / 客户" aria-label="搜索订单"><nav>
<a href="/help" target="_blank" style="color:#fff">帮助</a> <button id="logout">退出</button></nav></header>
<main><h1>订单列表</h1>
<button id="refresh">刷新</button> <button id="new">${v2 ? "创建订单" : "新建订单"}</button> <button id="wipe">删除全部</button>
<p id="status" role="status"></p>
<table><thead><tr><th>编号</th><th>客户</th><th>金额</th></tr></thead><tbody id="rows"></tbody></table></main>
<div class="modal" id="modal" role="dialog" aria-label="订单表单"><div><h2>新订单</h2>
<label>客户名 <input id="c" aria-label="客户名"></label><label>金额 <input id="a" aria-label="金额"></label>
<button id="save">保存</button></div></div>
<script>
if (!localStorage.getItem("token")) location.replace("/");
const rows = document.getElementById("rows");
async function load(delay) {
  document.getElementById("status").textContent = "加载中…";
  const list = await (await fetch("/api/orders?delay=" + delay)).json();
  rows.innerHTML = list.map(o => "<tr><td>" + o.id + "</td><td>" + o.customer + "</td><td>" + o.amount + "</td></tr>").join("");
  document.getElementById("status").textContent = "共 " + list.length + " 条";
}
load(300);
document.addEventListener("keydown", event => { if (event.key === "Escape") document.getElementById("modal").style.display = "none"; });
document.getElementById("refresh").onclick = () => load(2500);
document.getElementById("new").onclick = () => { document.getElementById("modal").style.display = "flex"; };
document.getElementById("save").onclick = async () => {
  await fetch("/api/orders", { method: "POST", body: JSON.stringify({ customer: c.value, amount: +a.value }) });
  document.getElementById("modal").style.display = "none"; load(200);
};
document.getElementById("wipe").onclick = async () => {
  if (confirm("确定删除全部订单？")) { await fetch("/api/orders", { method: "DELETE" }); load(100); }
};
document.getElementById("logout").onclick = () => { localStorage.removeItem("token"); location.href = "/"; };
</script>`);
const helpPage = shell("帮助", `<main><h1>帮助中心</h1><p>这是帮助页。</p></main>`);

const requests = [];
const handler = async (req, res) => {
  requests.push({ method: req.method, path: req.url });
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  const html = (s) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(s); };
  const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (url.pathname === "/") return html(loginPage);
  if (url.pathname === "/app") return html(appPage());
  if (url.pathname === "/help") return html(helpPage);
  if (url.pathname === "/api/login") { await sleep(600); return json({ ok: true }); }
  if (url.pathname === "/api/orders") {
    if (req.method === "POST") {
      let b = ""; for await (const c of req) b += c;
      const o = JSON.parse(b); orders.push({ id: orders.length + 1, ...o }); await sleep(200); return json({ ok: true });
    }
    if (req.method === "DELETE") { orders.length = 0; return json({ ok: true }); }
    await sleep(Number(url.searchParams.get("delay") ?? 0)); return json(orders);
  }
  res.statusCode = 404; res.end();
};
return { handler, orders, requests, setVersion(value) { v2 = value; } };


}
