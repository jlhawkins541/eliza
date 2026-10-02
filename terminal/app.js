const base = "http://127.0.0.1:8765";

const statusEl = document.getElementById("status");
const promptEl = document.getElementById("prompt");
const outputEl = document.getElementById("output");
const sendBtn = document.getElementById("send");

async function healthCheck() {
  try {
    const res = await fetch(`${base}/api/health`);
    const json = await res.json();
    statusEl.textContent = json.ok ? "Connected" : "Offline";
  } catch {
    statusEl.textContent = "Offline";
  }
}

async function sendPrompt() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eliza-Request": "chat",
      },
      body: JSON.stringify({ prompt }),
    });

    const json = await res.json();
    outputEl.textContent = json.text || json.error || "No response";
  } catch (error) {
    outputEl.textContent = String(error);
  }
}

sendBtn.addEventListener("click", sendPrompt);
healthCheck();
