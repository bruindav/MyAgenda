// Ochtendbericht: leest de afspraken van vandaag uit Firestore en stuurt
// ze via Telegram, voor één of meerdere personen. Draait als geplande
// GitHub Action (zie .github/workflows/ochtendbericht.yml).
//
// Nodig als omgevingsvariabelen (GitHub Secrets):
//   ONTVANGERS                - JSON-array met ontvangers, bv.:
//       [{"naam":"Dave","uid":"...","chatId":"..."},
//        {"naam":"Erwin","uid":"...","chatId":"..."}]
//   TELEGRAM_BOT_TOKEN        - token van de Telegram-bot (via @BotFather)
//   FIREBASE_SERVICE_ACCOUNT  - volledige inhoud van het service-account .json-bestand
//
// Voor terugwaartse compatibiliteit werkt ook nog de oude opzet met losse
// MY_UID + TELEGRAM_CHAT_ID secrets (voor precies één ontvanger), als
// ONTVANGERS niet is ingesteld.
//
// De workflow draait 2x per dag (voor zomer- en wintertijd); dit script
// bepaalt zelf of het echt binnen het verzendvenster (07:20-07:40
// Europe/Amsterdam) valt en stuurt anders niets - zo blijft het altijd
// 07:30 lokale tijd, ook rond de klok-omzetting.

const admin = require("firebase-admin");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FORCE     = process.env.FORCE === "1" || process.env.FORCE === "true";

function laadOntvangers() {
  if (process.env.ONTVANGERS) {
    const lijst = JSON.parse(process.env.ONTVANGERS);
    if (!Array.isArray(lijst) || lijst.length === 0) {
      throw new Error("ONTVANGERS moet een niet-lege JSON-array zijn");
    }
    return lijst.map(o => ({ naam: o.naam || "?", uid: o.uid, chatId: String(o.chatId) }));
  }
  // Terugwaartse compatibiliteit: oude losse secrets
  if (process.env.MY_UID && process.env.TELEGRAM_CHAT_ID) {
    return [{ naam: "jou", uid: process.env.MY_UID, chatId: process.env.TELEGRAM_CHAT_ID }];
  }
  throw new Error("Geen ontvangers geconfigureerd: zet ONTVANGERS (JSON-array), of MY_UID + TELEGRAM_CHAT_ID voor één ontvanger.");
}

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

async function verstuurTelegram(chatId, tekst) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: tekst, parse_mode: "Markdown" }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error("Telegram fout: " + JSON.stringify(json));
  }
}

async function verstuurVoorOntvanger(db, calendars, todayStr, ontvanger) {
  const evSnap = await db.collection("events")
    .where("members", "array-contains", ontvanger.uid)
    .get();

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
  await verstuurTelegram(ontvanger.chatId, bericht);
  console.log(`Ochtendbericht verstuurd naar ${ontvanger.naam}:\n${bericht}\n`);
}

async function main() {
  if (!BOT_TOKEN || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("TELEGRAM_BOT_TOKEN en/of FIREBASE_SERVICE_ACCOUNT ontbreekt");
  }
  const ontvangers = laadOntvangers();

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

  const calSnap = await db.collection("calendars").get();
  const calendars = {};
  calSnap.forEach(d => { calendars[d.id] = d.data(); });

  const resultaten = await Promise.allSettled(
    ontvangers.map(o => verstuurVoorOntvanger(db, calendars, todayStr, o))
  );

  const mislukt = resultaten
    .map((r, i) => ({ r, naam: ontvangers[i].naam }))
    .filter(x => x.r.status === "rejected");

  if (mislukt.length > 0) {
    mislukt.forEach(x => console.error(`Mislukt voor ${x.naam}:`, x.r.reason));
    throw new Error(`${mislukt.length} van de ${ontvangers.length} berichten mislukt`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
