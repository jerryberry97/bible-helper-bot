require('dotenv').config();

// ❗ ENV CHECK (prevents silent crashes)
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID");
  process.exit(1);
}

// 🌐 EXPRESS SERVER (FOR RENDER UPTIME)
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Bot is alive!');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

// 📖 Load Bible (FIXED BOM ISSUE)
const raw = fs.readFileSync('./bible.json', 'utf-8');
const clean = raw.replace(/^\uFEFF/, '');
const bible = JSON.parse(clean);

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// 📖 Commands
const commands = [
  new SlashCommandBuilder()
    .setName('ref')
    .setDescription('Get Bible verse from reference')
    .addStringOption(option =>
      option.setName('reference')
        .setDescription('Example: John 3:16')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('ver')
    .setDescription('Find reference from verse')
    .addStringOption(option =>
      option.setName('text')
        .setDescription('Enter part of verse')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

// 🔥 READY EVENT
client.once('ready', async () => {
  console.log(`📖 Bible Bot Online: ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log("Registering commands...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Commands registered!");
  } catch (err) {
    console.error("❌ Command registration error:", err);
  }
});

// ⚡ COMMAND HANDLER (FULL SAFE VERSION)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  console.log("Command received:", interaction.commandName);

  try {
    // 📖 /ref
    if (interaction.commandName === 'ref') {
      const reference = interaction.options.getString('reference');

      await interaction.deferReply();

      const res = await axios.get(
        `https://bible-api.com/${encodeURIComponent(reference)}?translation=kjv`
      );

      return await interaction.editReply(
        `📖 **${reference} (KJV)**\n${res.data.text}`
      );
    }

    // 🔍 /ver (OPTIMIZED SEARCH)
    if (interaction.commandName === 'ver') {
      const input = interaction.options.getString('text').toLowerCase();

      await interaction.deferReply();

      const words = input.split(" ").filter(w => w.length > 3);

      let bestMatch = null;
      let bestScore = 0;

      // ⚡ LIMIT SEARCH (prevents timeout)
      for (const book of bible.slice(0, 20)) {
        for (let c = 0; c < book.chapters.length; c++) {
          const chapter = book.chapters[c];

          for (let v = 0; v < chapter.length; v++) {
            const verseText = chapter[v].toLowerCase();

            let score = 0;

            for (const word of words) {
              if (verseText.includes(word)) score++;
            }

            if (score > bestScore) {
              bestScore = score;
              bestMatch = {
                book: book.name,
                chapter: c + 1,
                verse: v + 1,
                text: chapter[v]
              };
            }
          }
        }
      }

      if (bestMatch && bestScore >= 2) {
        return await interaction.editReply(
          `📖 **${bestMatch.book} ${bestMatch.chapter}:${bestMatch.verse} (KJV)**\n${bestMatch.text}`
        );
      }

      return await interaction.editReply(
        "⚠️ Verse not found.\n💡 Try simpler keywords"
      );
    }

  } catch (err) {
    console.error("❌ COMMAND ERROR:", err);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("⚠️ Error occurred while processing.");
    } else {
      await interaction.reply("⚠️ Error occurred.");
    }
  }
});

// 🔐 LOGIN (WITH DEBUG)
client.login(process.env.TOKEN)
  .then(() => console.log("✅ Login success"))
  .catch(err => console.error("❌ Login failed:", err));