// Ochtendbericht: leest de afspraken van vandaag uit Firestore en stuurt
// ze via Telegram en/of e-mail, per persoon volgens hun eigen voorkeuren
// (in te stellen in de app zelf via het 🔔-icoon). Draait als geplande
// GitHub Action (zie .github/workflows/ochtendbericht.yml).
//
// Nodig als omgevingsvariabelen (GitHub Secrets):
//   TELEGRAM_BOT_TOKEN        - token van de Telegram-bot (via @BotFather)
//   FIREBASE_SERVICE_ACCOUNT  - volledige inhoud van het service-account .json-bestand
//   GMAIL_USER                - Gmail-adres dat als afzender dient
//   GMAIL_APP_PASSWORD        - app-wachtwoord van dat Gmail-account
//
// Voorkeuren (wie wil wat, welk kanaal, welk adres/chat-id, wel/niet
// melden bij lege dag) staan NIET in GitHub-secrets, maar in Firestore
// onder meldingsinstellingen/{uid} - zelf in te stellen via de app, dus
// geen GitHub-configuratie nodig als er iemand bijkomt.
//
// BELANGRIJK over de timing: GitHub Actions' "schedule"-trigger is niet
// exact - bij drukte kan een geplande run makkelijk uren later pas echt
// starten. Daarom werkt dit script met twee lagen:
//   1) Een ruim venster (06:00-13:00 Europe/Amsterdam) i.p.v. een streng
//      venster van een paar minuten rond 07:30.
//   2) Een "al verstuurd vandaag?"-check in Firestore per ontvanger en
//      kanaal, zodat het bericht nooit dubbel verstuurd wordt als de
//      workflow meerdere keren binnen dat venster draait (de workflow
//      draait bewust elke 30 minuten, zodat het bericht zo snel mogelijk
//      na 07:30 binnenkomt zodra GitHub de run daadwerkelijk uitvoert).

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FORCE     = process.env.FORCE === "1" || process.env.FORCE === "true";

const EVENT_ICONS = {
  afspraak:   "📅",
  verjaardag: "🎂",
  vakantie:   "🏖️",
  bijzonder:  "⭐",
  sterfdag:   "🕯️",
  training:   "🏃",
};

// Voor deze types tonen we het label i.p.v. het generieke "Hele dag" bij
// een dag-vullende afspraak, bv. "Verjaardag Peter" i.p.v. "Hele dag Peter".
const EVENT_LABELS = {
  verjaardag: "Verjaardag",
  vakantie:   "Vakantie",
  bijzonder:  "Bijzondere dag",
  sterfdag:   "Sterfdag",
};

let mailTransporter = null;
function getMailTransporter() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return mailTransporter;
}

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

function escapeHtml(tekst) {
  return String(tekst).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function titelVoorDag(todayStr) {
  const dagNamen = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const maanden  = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  const [jr, mo, dg] = todayStr.split("-").map(Number);
  const dateObj = new Date(jr, mo - 1, dg);
  return `${dagNamen[dateObj.getDay()]} ${dg} ${maanden[mo - 1]} ${jr}`;
}

// Label voor de tijdsaanduiding van een event. Hele-dag-afspraken tonen
// normaal "Hele dag", maar dat leest onhandig bij bv. een verjaardag
// ("Hele dag Peter") - daarvoor tonen we liever het type ("Verjaardag Peter").
function labelVoorEvent(ev) {
  if (!ev.allDay) return ev.startTime || "";
  return EVENT_LABELS[ev.type] || "Hele dag";
}

function bouwTelegramBericht(todayStr, vandaagEvents, calendars) {
  const titel = titelVoorDag(todayStr);
  if (vandaagEvents.length === 0) {
    return `📅 *${titel}*\n\nGeen afspraken vandaag. Fijne dag! 🌤️`;
  }
  const regels = vandaagEvents.map(ev => {
    const icon = EVENT_ICONS[ev.type] || (ev.gcalImportId ? "📆" : "📅");
    const tijd = labelVoorEvent(ev);
    const calNaam = calendars[ev.calendarId]?.name;
    const titelTekst = escapeMarkdown(ev.title || "(geen titel)");
    return `${icon} ${tijd ? `*${tijd}* ` : ""}${titelTekst}${calNaam ? ` _(${escapeMarkdown(calNaam)})_` : ""}`;
  });
  return `📅 *${titel}*\n\n${regels.join("\n")}`;
}

function bouwEmailBericht(todayStr, vandaagEvents, calendars) {
  const titel = titelVoorDag(todayStr);
  const subject = `Agenda: ${titel}`;

  if (vandaagEvents.length === 0) {
    return {
      subject,
      text: `${titel}\n\nGeen afspraken vandaag. Fijne dag!`,
      html: `<h2>${escapeHtml(titel)}</h2><p>Geen afspraken vandaag. Fijne dag! 🌤️</p>`,
    };
  }

  const textRegels = vandaagEvents.map(ev => {
    const tijd = labelVoorEvent(ev);
    const calNaam = calendars[ev.calendarId]?.name;
    return `${tijd ? tijd + " - " : ""}${ev.title || "(geen titel)"}${calNaam ? ` (${calNaam})` : ""}`;
  });

  const htmlRegels = vandaagEvents.map(ev => {
    const icon = EVENT_ICONS[ev.type] || (ev.gcalImportId ? "📆" : "📅");
    const tijd = labelVoorEvent(ev);
    const calNaam = calendars[ev.calendarId]?.name;
    return `<li>${icon} ${tijd ? `<strong>${escapeHtml(tijd)}</strong> ` : ""}${escapeHtml(ev.title || "(geen titel)")}${calNaam ? ` <span style="color:#888">(${escapeHtml(calNaam)})</span>` : ""}</li>`;
  });

  return {
    subject,
    text: `${titel}\n\n${textRegels.join("\n")}`,
    html: `<h2>${escapeHtml(titel)}</h2><ul style="font-size:15px;line-height:1.6">${htmlRegels.join("")}</ul>`,
  };
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

async function verstuurEmail(naar, { subject, text, html }) {
  await getMailTransporter().sendMail({
    from: `Agenda <${process.env.GMAIL_USER}>`,
    to: naar,
    subject, text, html,
  });
}

async function alVerstuurd(db, uid, kanaal, todayStr) {
  const ref = db.collection("ochtendbericht_log").doc(`${uid}_${kanaal}_${todayStr}`);
  const snap = await ref.get();
  return { ref, verstuurd: snap.exists };
}

async function verstuurVoorGebruiker(db, calendars, todayStr, uid, instellingen) {
  const naam = instellingen.naam || uid;
  const wilTelegram = !!instellingen.telegramActief && !!instellingen.telegramChatId;
  const wilEmail    = !!instellingen.emailActief && !!instellingen.emailAdres;
  const meldBijLeeg = instellingen.meldenBijLeeg !== false;

  if (!wilTelegram && !wilEmail) {
    console.log(`${naam}: geen kanaal actief, overgeslagen.`);
    return;
  }

  const evSnap = await db.collection("events")
    .where("members", "array-contains", uid)
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

  if (vandaagEvents.length === 0 && !meldBijLeeg) {
    console.log(`${naam}: geen afspraken vandaag en wil geen melding bij lege dag, overgeslagen.`);
    return;
  }

  if (wilTelegram) {
    const { ref, verstuurd } = await alVerstuurd(db, uid, "telegram", todayStr);
    if (verstuurd && !FORCE) {
      console.log(`${naam}: Telegram al verstuurd vandaag, overgeslagen.`);
    } else {
      const bericht = bouwTelegramBericht(todayStr, vandaagEvents, calendars);
      await verstuurTelegram(instellingen.telegramChatId, bericht);
      await ref.set({ verstuurdOp: admin.firestore.Timestamp.now() });
      console.log(`${naam}: Telegram-bericht verstuurd.`);
    }
  }

  if (wilEmail) {
    const { ref, verstuurd } = await alVerstuurd(db, uid, "email", todayStr);
    if (verstuurd && !FORCE) {
      console.log(`${naam}: e-mail al verstuurd vandaag, overgeslagen.`);
    } else {
      const mail = bouwEmailBericht(todayStr, vandaagEvents, calendars);
      await verstuurEmail(instellingen.emailAdres, mail);
      await ref.set({ verstuurdOp: admin.firestore.Timestamp.now() });
      console.log(`${naam}: e-mail verstuurd.`);
    }
  }
}

async function main() {
  if (!BOT_TOKEN || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("TELEGRAM_BOT_TOKEN en/of FIREBASE_SERVICE_ACCOUNT ontbreekt");
  }

  const { dateStr: todayStr, hour, minute } = nowAmsterdam();
  const nuInMinuten = hour * 60 + minute;
  // Ruim venster (06:00-13:00 lokale tijd) omdat GitHub's geplande taken
  // met flinke vertraging kunnen draaien - de "al verstuurd?"-check per
  // ontvanger/kanaal voorkomt dat dit ooit tot dubbele berichten leidt.
  const vensterStart = 6 * 60;
  const vensterEind  = 13 * 60;
  if (!FORCE && (nuInMinuten < vensterStart || nuInMinuten > vensterEind)) {
    console.log(`Buiten het ochtendvenster (nu ${hour}:${String(minute).padStart(2, "0")} Europe/Amsterdam). Niets verstuurd.`);
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
  const db = admin.firestore();

  const [calSnap, instellingenSnap] = await Promise.all([
    db.collection("calendars").get(),
    db.collection("meldingsinstellingen").get(),
  ]);

  const calendars = {};
  calSnap.forEach(d => { calendars[d.id] = d.data(); });

  if (instellingenSnap.empty) {
    console.log("Niemand heeft meldingsinstellingen aangemaakt (via het 🔔-icoon in de app). Niets te versturen.");
    return;
  }

  const gebruikers = [];
  instellingenSnap.forEach(d => gebruikers.push({ uid: d.id, instellingen: d.data() }));

  const resultaten = await Promise.allSettled(
    gebruikers.map(g => verstuurVoorGebruiker(db, calendars, todayStr, g.uid, g.instellingen))
  );

  const mislukt = resultaten
    .map((r, i) => ({ r, naam: gebruikers[i].instellingen.naam || gebruikers[i].uid }))
    .filter(x => x.r.status === "rejected");

  if (mislukt.length > 0) {
    mislukt.forEach(x => console.error(`Mislukt voor ${x.naam}:`, x.r.reason));
    throw new Error(`${mislukt.length} van de ${gebruikers.length} verstuur-pogingen mislukt`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
