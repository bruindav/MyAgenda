// Ochtendbericht: leest de afspraken van vandaag uit Firestore en stuurt
// ze via Telegram. Draait als geplande GitHub Action (zie
// .github/workflows/ochtendbericht.yml).
//
// Nodig als omgevingsvariabelen (GitHub Secrets):
//   MY_UID                   - jouw Firebase Auth uid
//   TELEGRAM_BOT_TOKEN       - token van je Telegram-bot (via @BotFather)
//   TELEGRAM_CHAT_ID         - jouw Telegram chat-id (via @userinfobot)
//   FIREBASE_SERVICE_ACCOUNT - volledige inhoud van het service-account .json-bestand
//
// De workflow draait 2x per dag (voor zomer- en wintertijd); dit script
// bepaalt zelf of het echt binnen het verzendvenster (07:20-07:40
// Europe/Amsterdam) valt en stuurt anders niets - zo blijft het altijd
// 07:30 lokale tijd, ook rond de klok-omzetting.

const admin = require("firebase-admin");

const MY_UID    = process.env.MY_UID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const FORCE     = process.env.FORCE === "1" || process.env.FORCE === "true";

const EVENT_ICONS = {
  afspraak:   "📅",
  verjaardag: "🎂",
  vakantie:   "🏖️",
  bijzonder:  "⭐",
  sterfdag:   "🕯️",
  training:   "🏃",
};

function nowAmsterdam() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function toDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function matchesRepeat(ev, todayStr) {
  const origin = toDate(ev.startDate || ev.date);
  origin.setHours(0, 0, 0, 0);
  const t = toDate(todayStr);
  t.setHours(0, 0, 0, 0);
  if (t < origin) return false;
  if (ev.repeatEnd) {
    const re = toDate(ev.repeatEnd);
    re.setHours(0, 0, 0, 0);
    if (t > re) return false;
  }
  const diff = Math.round((t - origin) / 86400000);
  if (ev.repeat === "daily")   return true;
  if (ev.repeat === "weekly")  return diff % 7 === 0;
  if (ev.repeat === "monthly") return origin.getDate() === t.getDate();
  if (ev.repeat === "yearly")  return origin.getDate() === t.getDate() && origin.getMonth() === t.getMonth();
  return false;
}

function valtVandaag(ev, todayStr) {
  const startStr = ev.startDate || ev.date;
  if (!startStr) return false;
  if (!ev.repeat || ev.repeat === "none") {
    const endStr = ev.endDate || startStr;
    return startStr <= todayStr && todayStr <= endStr;
  }
  return matchesRepeat(ev, todayStr);
}

function escapeMarkdown(tekst) {
  return String(tekst).replace(/([_*`\[])/g, "\\$1");
}

function bouwBericht(todayStr, vandaagEvents, calendars) {
  const dagNamen = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const maanden  = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  const [jr, mo, dg] = todayStr.split("-").map(Number);
  const dateObj = new Date(jr, mo - 1, dg);
  const titel = `${dagNamen[dateObj.getDay()]} ${dg} ${maanden[mo - 1]} ${jr}`;

  if (vandaagEvents.length === 0) {
    return `📅 *${titel}*\n\nGeen afspraken vandaag. Fijne dag! 🌤️`;
  }

  const regels = vandaagEvents.map(ev => {
    const icon = EVENT_ICONS[ev.type] || (ev.gcalImportId ? "📆" : "📅");
    const tijd = ev.allDay ? "Hele dag" : (ev.startTime || "");
    const calNaam = calendars[ev.calendarId]?.name;
    const titelTekst = escapeMarkdown(ev.title || "(geen titel)");
    return `${icon} ${tijd ? `*${tijd}* ` : ""}${titelTekst}${calNaam ? ` _(${escapeMarkdown(calNaam)})_` : ""}`;
  });

  return `📅 *${titel}*\n\n${regels.join("\n")}`;
}

async function verstuurTelegram(tekst) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: tekst, parse_mode: "Markdown" }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error("Telegram fout: " + JSON.stringify(json));
  }
}

async function main() {
  if (!MY_UID || !BOT_TOKEN || !CHAT_ID || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Een of meer verplichte environment-variabelen ontbreken (MY_UID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_SERVICE_ACCOUNT)");
  }

  const { dateStr: todayStr, hour, minute } = nowAmsterdam();
  const nuInMinuten   = hour * 60 + minute;
  const doelInMinuten = 7 * 60 + 30;
  if (!FORCE && Math.abs(nuInMinuten - doelInMinuten) > 10) {
    console.log(`Niet binnen het verzendvenster (nu ${hour}:${String(minute).padStart(2, "0")} Europe/Amsterdam). Niets verstuurd.`);
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
  const db = admin.firestore();

  const [calSnap, evSnap] = await Promise.all([
    db.collection("calendars").get(),
    db.collection("events").where("members", "array-contains", MY_UID).get(),
  ]);

  const calendars = {};
  calSnap.forEach(d => { calendars[d.id] = d.data(); });

  const events = [];
  evSnap.forEach(d => events.push({ id: d.id, ...d.data() }));

  const vandaagEvents = events
    .filter(ev => valtVandaag(ev, todayStr))
    .sort((a, b) => {
      const ta = a.allDay ? "" : (a.startTime || "00:00");
      const tb = b.allDay ? "" : (b.startTime || "00:00");
      return ta.localeCompare(tb);
    });

  const bericht = bouwBericht(todayStr, vandaagEvents, calendars);
  await verstuurTelegram(bericht);
  console.log("Ochtendbericht verstuurd:\n" + bericht);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
