"use strict";

const $ = (id) => document.getElementById(id);
const statusElement = $("status");
const subtitleSelect = $("subtitleSelect");
const plainButton = $("plainButton");
const timestampButton = $("timestampButton");
const copyButton = $("copyButton");
const downloadButton = $("downloadButton");
const outputElement = $("output");

let currentVideo = null;
let subtitleTracks = [];

function setStatus(message, type = "normal") {
  statusElement.textContent = message;
  statusElement.className = type === "error" ? "error" : type === "success" ? "success" : "";
}

function setControlsEnabled(enabled) {
  subtitleSelect.disabled = !enabled;
  plainButton.disabled = !enabled;
  timestampButton.disabled = !enabled;
}

function normalizeSubtitleUrl(url) {
  if (!url) throw new Error("字幕地址为空");
  return url.startsWith("//") ? `https:${url}` : url;
}

function getBvidFromUrl(url) {
  const match = url.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  if (!match) throw new Error("当前页面不是有效的 Bilibili BV 视频页面");
  return match[1];
}

function getPageNumberFromUrl(url) {
  const value = Number.parseInt(new URL(url).searchParams.get("p") || "1", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function formatTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const remain = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(remain).padStart(3,"0")}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status} ${response.statusText}`);
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`接口没有返回有效 JSON：${text.slice(0, 120)}`); }
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].url) throw new Error("无法读取当前标签页");
  return tabs[0];
}

async function loadVideoInformation() {
  setStatus("正在读取当前视频……");
  setControlsEnabled(false);
  const tab = await getCurrentTab();
  const bvid = getBvidFromUrl(tab.url);
  const pageNumber = getPageNumberFromUrl(tab.url);
  const info = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (info.code !== 0 || !info.data) throw new Error(info.message || "读取视频信息失败");
  const { aid, title, pages = [] } = info.data;
  if (!pages.length) throw new Error("视频没有可用的分 P 信息");
  const selectedPage = pages.find((p) => p.page === pageNumber) || pages[pageNumber - 1] || pages[0];
  if (!selectedPage?.cid) throw new Error(`找不到第 ${pageNumber} P 的 CID`);
  currentVideo = { bvid, aid, cid: selectedPage.cid, page: selectedPage.page, title, part: selectedPage.part || title };
  await loadSubtitleTracks();
}

async function loadSubtitleTracks() {
  const { aid, cid, bvid, page, title, part } = currentVideo;
  setStatus(`正在读取字幕：${title} · P${page} ${part}`);
  const player = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}&bvid=${encodeURIComponent(bvid)}`);
  if (player.code !== 0 || !player.data) throw new Error(player.message || "读取播放器信息失败");
  subtitleTracks = player.data.subtitle?.subtitles || [];
  subtitleSelect.innerHTML = "";
  if (!subtitleTracks.length) {
    subtitleSelect.innerHTML = "<option>没有独立字幕轨道</option>";
    setStatus("该视频没有独立字幕轨道。画面文字很可能是硬字幕。", "error");
    return;
  }
  subtitleTracks.sort((a, b) => (a.ai_status === 0 ? 0 : 1) - (b.ai_status === 0 ? 0 : 1));
  subtitleTracks.forEach((track, index) => {
    const option = document.createElement("option");
    const language = track.lan_doc || track.lan || `字幕 ${index + 1}`;
    const source = track.ai_status === 0 ? "人工字幕" : track.ai_status === 2 ? "AI 字幕" : `状态 ${track.ai_status ?? "未知"}`;
    option.value = String(index);
    option.textContent = `${language} · ${source}`;
    subtitleSelect.appendChild(option);
  });
  setControlsEnabled(true);
  setStatus(`找到 ${subtitleTracks.length} 条字幕轨道，已优先选择人工字幕。`, "success");
}

async function loadSelectedSubtitle(mode) {
  const track = subtitleTracks[Number.parseInt(subtitleSelect.value, 10)];
  if (!track) throw new Error("请选择有效的字幕轨道");
  setStatus("正在下载并解析字幕……");
  const json = await fetchJson(normalizeSubtitleUrl(track.subtitle_url), { credentials: "omit" });
  const body = Array.isArray(json.body) ? json.body : [];
  if (!body.length) throw new Error("字幕文件中没有有效内容");
  const text = mode === "timestamp"
    ? body.map((item) => `[${formatTime(item.from)} --> ${formatTime(item.to)}] ${String(item.content || "").trim()}`).join("\n")
    : body.map((item) => String(item.content || "").trim()).filter(Boolean).join("\n");
  outputElement.value = text;
  copyButton.disabled = !text;
  downloadButton.disabled = !text;
  setStatus(`提取完成，共 ${body.length} 条字幕。`, "success");
}

async function copyCurrentText() {
  const text = outputElement.value.trim();
  if (!text) throw new Error("没有可复制的字幕文本");
  await navigator.clipboard.writeText(text);
  setStatus("字幕已复制到剪贴板。", "success");
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

async function downloadCurrentText() {
  const text = outputElement.value;
  if (!text.trim()) throw new Error("没有可下载的字幕文本");
  const title = sanitizeFilename(currentVideo?.title || "bilibili-subtitle");
  const part = currentVideo?.part && currentVideo.part !== currentVideo.title ? `-${sanitizeFilename(currentVideo.part)}` : "";
  const filename = `${title}${part}-P${currentVideo?.page || 1}.txt`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  setStatus(`已请求下载：${filename}`, "success");
}

plainButton.addEventListener("click", () => loadSelectedSubtitle("plain").catch((e) => setStatus(e.message, "error")));
timestampButton.addEventListener("click", () => loadSelectedSubtitle("timestamp").catch((e) => setStatus(e.message, "error")));
copyButton.addEventListener("click", () => copyCurrentText().catch((e) => setStatus(e.message, "error")));
downloadButton.addEventListener("click", () => downloadCurrentText().catch((e) => setStatus(e.message, "error")));
loadVideoInformation().catch((e) => { console.error(e); setStatus(e.message, "error"); });
