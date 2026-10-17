const STORAGE_KEY = "daywell-wellness-v1";
const DEFAULT_SETTINGS = {
  name: "",
  calorieGoal: 2000,
  proteinGoal: 100,
  checkInTime: "09:00",
  workoutTime: "17:30",
  language: "en",
  voiceReplies: true,
  notifications: false,
};

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
      entries: Array.isArray(stored.entries) ? stored.entries : [],
      messages: Array.isArray(stored.messages) ? stored.messages.slice(-80) : [],
      reminders: stored.reminders && typeof stored.reminders === "object" ? stored.reminders : {},
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, entries: [], messages: [], reminders: {} };
  }
}

const state = loadState();
const byId = (id) => document.getElementById(id);
let isBusy = false;
let recorder = null;
let recordingStream = null;
let recordingTimer = null;
let toastTimer = null;

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    showToast("This browser could not save your history. Check available storage.", "error");
  }
}

function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayEntries() {
  const today = dayKey();
  return state.entries.filter((entry) => entry.date === today);
}

function totals(entries) {
  const meals = entries.filter((entry) => entry.type === "meal");
  const workouts = entries.filter((entry) => entry.type === "workout");
  const sleep = entries.filter((entry) => entry.type === "sleep");
  const energy = entries.filter((entry) => entry.type === "energy");
  return {
    calories: meals.reduce((sum, item) => sum + (item.calories || 0), 0),
    protein: meals.reduce((sum, item) => sum + (item.protein_g || 0), 0),
    carbs: meals.reduce((sum, item) => sum + (item.carbs_g || 0), 0),
    fat: meals.reduce((sum, item) => sum + (item.fat_g || 0), 0),
    workoutMinutes: workouts.reduce((sum, item) => sum + (item.minutes || 0), 0),
    workouts: workouts.length,
    sleepHours: sleep.reduce((sum, item) => sum + (item.hours || 0), 0),
    energy: energy.length ? energy[energy.length - 1].energy : null,
  };
}

function setText(id, text) {
  byId(id).textContent = text;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString();
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Today" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function render() {
  const now = new Date();
  const entries = todayEntries();
  const day = totals(entries);
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 17 ? "Good afternoon" : "Good evening";
  setText("today-date", now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }).toUpperCase());
  setText("greeting", `${greeting}${state.settings.name ? `, ${state.settings.name}` : ""}. Small check-ins. A clearer picture.`);
  setText("streak-value", `${getStreak()} day${getStreak() === 1 ? "" : "s"} with a check-in`);

  setText("calorie-total", formatNumber(day.calories));
  setText("calorie-target", formatNumber(state.settings.calorieGoal));
  const caloriePercent = Math.min(100, (day.calories / state.settings.calorieGoal) * 100);
  byId("calorie-ring").style.setProperty("--progress", `${caloriePercent}%`);
  byId("calorie-ring").setAttribute("aria-label", `${formatNumber(day.calories)} of ${formatNumber(state.settings.calorieGoal)} calories`);
  setText("calorie-caption", day.calories ? `${Math.max(0, state.settings.calorieGoal - day.calories).toLocaleString()} kcal to goal` : "No meals logged yet");

  const macroValues = [
    ["protein", day.protein, state.settings.proteinGoal],
    ["carbs", day.carbs, 250],
    ["fat", day.fat, 70],
  ];
  for (const [name, value, goal] of macroValues) {
    setText(`${name}-total`, formatNumber(value));
    byId(`${name}-bar`).style.width = `${Math.min(100, (value / goal) * 100)}%`;
  }

  setText("sleep-total", day.sleepHours ? `${day.sleepHours.toFixed(1)} hours` : "Not logged");
  setText("workout-total", day.workouts ? `${day.workouts} session${day.workouts === 1 ? "" : "s"}${day.workoutMinutes ? ` · ${day.workoutMinutes} min` : ""}` : "Not logged");
  setText("energy-total", day.energy ? `${day.energy} out of 5` : "Not logged");
  setText("entry-count", `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
  byId("empty-history").hidden = entries.length > 0;
  renderEntries(entries);
  renderConversation();
}

function getStreak() {
  const loggedDays = new Set(state.entries.map((entry) => entry.date));
  const cursor = new Date();
  if (!loggedDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (loggedDays.has(dayKey(cursor)) && streak < 366) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function renderEntries(entries) {
  const list = byId("activity-list");
  list.replaceChildren();
  for (const entry of entries.slice().reverse().slice(0, 10)) {
    const row = document.createElement("article");
    row.className = `activity-item activity-${entry.type}`;
    const marker = document.createElement("span");
    marker.className = "activity-marker";
    marker.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "activity-content";
    const title = document.createElement("strong");
    title.textContent = entry.label || entry.type;
    const detail = document.createElement("span");
    detail.textContent = entryDetail(entry);
    content.append(title, detail);
    const time = document.createElement("time");
    time.textContent = formatTime(entry.createdAt);
    row.append(marker, content, time);
    list.append(row);
  }
}

function entryDetail(entry) {
  if (entry.type === "meal") {
    const pieces = [];
    if (entry.calories) pieces.push(`~${formatNumber(entry.calories)} kcal`);
    if (entry.protein_g) pieces.push(`${formatNumber(entry.protein_g)} g protein`);
    if (entry.carbs_g) pieces.push(`${formatNumber(entry.carbs_g)} g carbs`);
    if (entry.fat_g) pieces.push(`${formatNumber(entry.fat_g)} g fat`);
    return pieces.length ? pieces.join(" · ") : "Nutrition details not estimated";
  }
  if (entry.type === "workout") return entry.minutes ? `${formatNumber(entry.minutes)} min of movement` : "Movement logged";
  if (entry.type === "sleep") return entry.hours ? `${entry.hours.toFixed(1)} hours of rest` : "Sleep logged";
  return entry.energy ? `Energy: ${entry.energy} out of 5` : "Energy check-in";
}

function renderConversation() {
  const conversation = byId("conversation");
  conversation.replaceChildren();
  if (!state.messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    const kicker = document.createElement("span");
    kicker.className = "welcome-kicker";
    kicker.textContent = "A fresh start";
    const text = document.createElement("p");
    text.textContent = "How are you feeling today? Tell me what you ate, how you moved, or how you slept. I’ll keep track as we talk.";
    welcome.append(kicker, text);
    conversation.append(welcome);
    return;
  }
  for (const message of state.messages.slice(-8)) {
    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${message.role === "user" ? "user-message" : "coach-message"}`;
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = message.role === "user" ? "You" : "Daywell";
    const text = document.createElement("p");
    text.textContent = message.content;
    bubble.append(label, text);
    conversation.append(bubble);
  }
  conversation.scrollTop = conversation.scrollHeight;
}

function showToast(message, type = "") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 4200);
}

function setCoachStatus(message) {
  setText("coach-status", message);
}

function languageLabel() {
  return {
    en: "English",
    hinglish: "natural Hinglish (Hindi and English mixed)",
    hi: "Hindi",
    ta: "Tamil and English mixed naturally",
    te: "Telugu and English mixed naturally",
    kn: "Kannada and English mixed naturally",
  }[state.settings.language] || "English";
}

function recentContext() {
  const today = dayKey();
  const since = new Date();
  since.setDate(since.getDate() - 6);
  const recent = state.entries.filter((entry) => entry.date >= dayKey(since));
  const latestSleep = recent.filter((entry) => entry.type === "sleep").slice(-1)[0];
  const latestEnergy = recent.filter((entry) => entry.type === "energy").slice(-1)[0];
  return {
    language: languageLabel(),
    goals: { calories: state.settings.calorieGoal, protein_g: state.settings.proteinGoal },
    today: { date: today, ...totals(todayEntries()) },
    last_seven_days: {
      meals_logged: recent.filter((entry) => entry.type === "meal").length,
      workouts: recent.filter((entry) => entry.type === "workout").length,
      latest_sleep_hours: latestSleep?.hours ?? null,
      latest_energy: latestEnergy?.energy ?? null,
    },
  };
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text || isBusy) return;
  isBusy = true;
  byId("send-button").disabled = true;
  setCoachStatus("Listening to your check-in…");
  state.messages.push({ role: "user", content: text });
  state.messages = state.messages.slice(-80);
  renderConversation();
  saveState();
  try {
    const response = await api("/api/chat", {
      text,
      context: recentContext(),
      history: state.messages.slice(-11, -1),
    });
    const reply = response.reply || "Got it. I’ve updated your day.";
    state.messages.push({ role: "assistant", content: reply });
    const createdAt = new Date().toISOString();
    for (const entry of response.entries || []) {
      state.entries.push({ ...entry, id: `${Date.now()}-${Math.random()}`, date: dayKey(), createdAt });
    }
    state.entries = state.entries.slice(-2000);
    if (response.recommendation) {
      byId("recommendation-panel").hidden = false;
      setText("recommendation-text", response.recommendation);
    }
    saveState();
    render();
    setCoachStatus(response.entries?.length ? "Your check-in is saved" : "Ready when you are");
    if (state.settings.voiceReplies) speakReply(reply);
  } catch (error) {
    setCoachStatus("Couldn’t reach your coach");
    showToast(error.message, "error");
  } finally {
    isBusy = false;
    byId("send-button").disabled = false;
  }
}

async function speakReply(text) {
  try {
    const language = state.settings.language === "hinglish" ? "en-IN" : `${state.settings.language}-IN`;
    const result = await api("/api/speak", { text, language });
    const audio = new Audio(`data:${result.mime};base64,${result.audio}`);
    await audio.play();
  } catch {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = state.settings.language === "hinglish" ? "hi-IN" : `${state.settings.language}-IN`;
      utterance.rate = 0.85;
      window.speechSynthesis.speak(utterance);
    }
  }
}

async function startRecording() {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("Voice recording is not supported here. You can still type your check-in.", "error");
    return;
  }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(recordingTimer);
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      byId("record-button").classList.remove("recording");
      byId("record-button").innerHTML = '<span class="record-icon" aria-hidden="true"></span><span>Talk</span>';
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (!blob.size) {
        setCoachStatus("No audio captured. Try again.");
        return;
      }
      setCoachStatus("Transcribing your check-in…");
      try {
        const audio = await blobToDataUrl(blob);
        const result = await api("/api/transcribe", { audio, mime: blob.type || "audio/webm" });
        const transcript = result.transcript.trim();
        if (!transcript) throw new Error("I couldn’t hear that clearly. Try again or type your check-in.");
        byId("message-input").value = transcript;
        await sendMessage(transcript);
        byId("message-input").value = "";
      } catch (error) {
        setCoachStatus("Ready when you are");
        showToast(error.message, "error");
      }
    };
    recorder.start();
    byId("record-button").classList.add("recording");
    byId("record-button").innerHTML = '<span class="record-icon" aria-hidden="true"></span><span>Stop</span>';
    setCoachStatus("Recording… tap Stop when you’re done");
    recordingTimer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, 30000);
  } catch (error) {
    setCoachStatus("Ready when you are");
    showToast(error.name === "NotAllowedError" ? "Allow microphone access to use voice check-ins." : "Microphone unavailable. You can still type your check-in.", "error");
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.readAsDataURL(blob);
  });
}

function openSettings() {
  byId("name-setting").value = state.settings.name;
  byId("calorie-setting").value = state.settings.calorieGoal;
  byId("protein-setting").value = state.settings.proteinGoal;
  byId("checkin-setting").value = state.settings.checkInTime;
  byId("workout-setting").value = state.settings.workoutTime;
  byId("voice-setting").checked = state.settings.voiceReplies;
  byId("notification-help").textContent = state.settings.notifications
    ? "Reminders are enabled on this device while Daywell is open."
    : "Reminders appear while Daywell is open. Browser notification permission is optional.";
  byId("notification-button").textContent = state.settings.notifications ? "Reminders enabled" : "Enable reminders on this device";
  byId("settings-dialog").showModal();
}

function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  state.settings = {
    ...state.settings,
    name: byId("name-setting").value.trim(),
    calorieGoal: Number(byId("calorie-setting").value),
    proteinGoal: Number(byId("protein-setting").value),
    checkInTime: byId("checkin-setting").value,
    workoutTime: byId("workout-setting").value,
    voiceReplies: byId("voice-setting").checked,
  };
  saveState();
  render();
  byId("settings-dialog").close();
  showToast("Preferences saved.");
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    byId("notification-help").textContent = "This browser does not support desktop notifications. Check-ins still appear while Daywell is open.";
    return;
  }
  const permission = await Notification.requestPermission();
  state.settings.notifications = permission === "granted";
  saveState();
  byId("notification-help").textContent = state.settings.notifications
    ? "Reminders are enabled on this device while Daywell is open."
    : "Notifications were not enabled. You can change this in your browser settings.";
  byId("notification-button").textContent = state.settings.notifications ? "Reminders enabled" : "Enable reminders on this device";
  if (state.settings.notifications) showToast("Daily reminders are on.");
}

function minutesOfDay(value) {
  const [hours, minutes] = (value || "09:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function notifyReminder(key, title, message) {
  if (state.reminders[key]) return;
  state.reminders[key] = true;
  saveState();
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body: message, tag: key });
  } else {
    showToast(`${title} ${message}`);
  }
}

function checkReminders() {
  if (!state.settings.notifications) return;
  const now = new Date();
  const today = dayKey(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const entries = todayEntries();
  if (currentMinutes >= minutesOfDay(state.settings.checkInTime) && !entries.length) {
    notifyReminder(`checkin-${today}`, "A quick check-in?", "Tell me how today is going.");
  }
  const workoutDue = minutesOfDay(state.settings.workoutTime);
  const hasWorkout = entries.some((entry) => entry.type === "workout");
  if (!hasWorkout && currentMinutes >= workoutDue + 120) {
    notifyReminder(`followup-${today}`, "Plans change. That’s okay.", "Want to fit in a little movement, or adjust today’s plan?");
    state.reminders[`workout-${today}`] = true;
    saveState();
  } else if (!hasWorkout && currentMinutes >= workoutDue) {
    notifyReminder(`workout-${today}`, "A gentle nudge", "Your workout is still on the plan. How’s your energy feeling?");
  }
}

function setupEvents() {
  byId("message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId("message-input");
    const text = input.value;
    if (text.trim()) {
      input.value = "";
      sendMessage(text);
    }
  });
  byId("record-button").addEventListener("click", startRecording);
  document.querySelectorAll(".settings-open").forEach((button) => button.addEventListener("click", openSettings));
  byId("settings-close").addEventListener("click", () => byId("settings-dialog").close());
  byId("settings-form").addEventListener("submit", saveSettings);
  byId("notification-button").addEventListener("click", enableNotifications);
  byId("language-select").value = state.settings.language;
  byId("language-select").addEventListener("change", (event) => {
    state.settings.language = event.target.value;
    saveState();
  });
  byId("clear-history").addEventListener("click", () => {
    if (!window.confirm("Clear your check-ins and conversation from this device? This cannot be undone.")) return;
    state.entries = [];
    state.messages = [];
    state.reminders = {};
    saveState();
    byId("recommendation-panel").hidden = true;
    render();
    byId("settings-dialog").close();
    showToast("Your history has been cleared.");
  });
}

async function checkApiStatus() {
  try {
    const response = await fetch("/api/status");
    const result = await response.json();
    byId("setup-banner").hidden = result.configured;
  } catch {
    byId("setup-banner").hidden = false;
    setCoachStatus("Coach service unavailable");
  }
}

setupEvents();
render();
checkApiStatus();
checkReminders();
setInterval(checkReminders, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });