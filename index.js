require('dotenv').config();

const express = require('express');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.get('/',       (_req, res) => res.json({ status: 'ok', pid: process.pid, uptime: process.uptime() }));
app.get('/health', (_req, res) => res.json({ status: 'ok', verses: bibleFlat.length, pid: process.pid }));

const server = app.listen(PORT, () => console.log(`🌐 Health server running on port ${PORT}`));

// ──────────────────────────────────────────────
//  ENV CHECK
// ──────────────────────────────────────────────
const REQUIRED_ENV = ['TOKEN', 'CLIENT_ID'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const axios = require('axios');
const fs    = require('fs');

console.log(`🚀 Process started — PID ${process.pid} — ${new Date().toISOString()}`);

// ──────────────────────────────────────────────
//  LOAD BIBLE
// ──────────────────────────────────────────────
let bibleFlat = [];

try {
  const raw   = fs.readFileSync('./bible.json', 'utf-8').replace(/^\uFEFF/, '');
  const bible = JSON.parse(raw);

  for (const book of bible) {
    for (let c = 0; c < book.chapters.length; c++) {
      for (let v = 0; v < book.chapters[c].length; v++) {
        const text = book.chapters[c][v];
        bibleFlat.push({ book: book.name, chapter: c + 1, verse: v + 1, text, textLower: text.toLowerCase() });
      }
    }
  }
  console.log(`✅ Bible loaded — ${bibleFlat.length.toLocaleString()} verses`);
} catch (err) {
  console.error('❌ Bible load error:', err.message);
}

// ──────────────────────────────────────────────
//  COMMANDS
// ──────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('ref')
    .setDescription('Fetch a Bible verse by reference')
    .addStringOption(o =>
      o.setName('reference').setDescription('e.g. John 3:16 | Genesis 1:1-3').setRequired(true).setMaxLength(100)
    ),
  new SlashCommandBuilder()
    .setName('ver')
    .setDescription('Find a verse by keywords')
    .addStringOption(o =>
      o.setName('text').setDescription('e.g. love your enemies | faith hope charity').setRequired(true).setMaxLength(200)
    ),
].map(c => c.toJSON());

// ──────────────────────────────────────────────
//  CLIENT
// ──────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ──────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────
function verseEmbed(reference, text, color = 0x3b82f6) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '📖 Holy Bible — KJV' })
    .setTitle(reference)
    .setDescription(text.trim())
    .setFooter({ text: 'King James Version' })
    .setTimestamp();
}

function searchVerse(rawInput) {
  const input = rawInput.toLowerCase().trim();
  const STOP  = new Set(['the','and','for','that','this','with','have','from','are','was','but','not','all','they','his','her','our','you','your','him','its','their']);
  const words = input.split(/\s+/).map(w => w.replace(/[^a-z']/g, '')).filter(w => w.length >= 2 && !STOP.has(w));

  if (!words.length) return null;

  let bestMatch = null, bestScore = 0;

  for (const entry of bibleFlat) {
    let score = words.filter(w => entry.textLower.includes(w)).length;
    if (words.length > 1 && entry.textLower.includes(input)) score += words.length;
    if (score > bestScore) { bestScore = score; bestMatch = entry; }
  }

  return bestScore >= 1 ? { ...bestMatch, score: bestScore } : null;
}

async function fetchVerse(reference) {
  const res = await axios.get(
    `https://bible-api.com/${encodeURIComponent(reference)}?translation=kjv`,
    { timeout: 8000, validateStatus: s => s === 200 }
  );
  const { reference: ref, text } = res.data;
  if (!ref || !text) throw new Error('Unexpected API response');
  return { reference: ref, text };
}

// ──────────────────────────────────────────────
//  READY
// ──────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err.message);
  }
});

// ──────────────────────────────────────────────
//  INTERACTIONS
// ──────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  console.log(`🔔 Interaction | cmd: ${interaction.commandName ?? 'N/A'} | user: ${interaction.user?.tag}`);

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'ref') {
    const reference = interaction.options.getString('reference').trim();
    await interaction.deferReply();

    try {
      const { reference: ref, text } = await fetchVerse(reference);
      return await interaction.editReply({ embeds: [verseEmbed(ref, text)] });
    } catch (err) {
      console.error(`[/ref] ${err.message}`);
      const notFound = err.response?.status === 404 || err.message?.includes('404');
      return await interaction.editReply(
        notFound
          ? `❌ **"${reference}"** not found. Try a format like \`John 3:16\` or \`Genesis 1:1-3\``
          : `⚠️ Could not reach the Bible API. Please try again shortly.`
      );
    }
  }

  if (commandName === 'ver') {
    const input = interaction.options.getString('text').trim();
    await interaction.deferReply();

    if (!bibleFlat.length)
      return await interaction.editReply('⚠️ Bible data unavailable. Please contact the bot owner.');

    const match = searchVerse(input);

    if (!match)
      return await interaction.editReply(`❌ No verse found for **"${input}"**. Try simpler keywords.`);

    const ref   = `${match.book} ${match.chapter}:${match.verse}`;
    const embed = verseEmbed(ref, match.text, 0x10b981)
      .setFooter({ text: `King James Version  •  Matched ${match.score} keyword(s)` });

    return await interaction.editReply({ embeds: [embed] });
  }
});

// ──────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ──────────────────────────────────────────────
function shutdown(signal) {
  console.log(`⚠️ ${signal} — shutting down PID ${process.pid}`);
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));

// ──────────────────────────────────────────────
//  LOGIN
// ──────────────────────────────────────────────
client.login(process.env.TOKEN)
  .then(() => console.log('✅ Discord login successful'))
  .catch(err => { console.error('❌ Login failed:', err.message); process.exit(1); });