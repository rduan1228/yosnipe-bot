const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// In-memory storage (replace with database for persistence)
const snipeData = {
  // userId: { sniped: [userIds], snipedBy: [userIds] }
};

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Log a snipe against a user')
    .addUserOption(option =>
      option.setName('target')
        .setDescription('The user you sniped')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('snipestats')
    .setDescription('View snipe statistics')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to check stats for (defaults to you)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View snipe leaderboards')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of leaderboard')
        .setRequired(false)
        .addChoices(
          { name: 'Top Snipers', value: 'snipers' },
          { name: 'Most Sniped Victims', value: 'victims' }
        )),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot commands and usage'),
].map(command => command.toJSON());

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');
    
    // Register commands globally (takes up to 1 hour to sync)
    // For instant registration in your server, use the commented code below instead
    // await rest.put(
    //   Routes.applicationCommands(client.user.id),
    //   { body: commands },
    // );
    
    // FOR INSTANT REGISTRATION IN YOUR SERVER (recommended for testing):
    // Uncomment this and replace 'YOUR_GUILD_ID' with your server ID
    
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, '1461152927451451446'),
      { body: commands },
    );
    
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // /snipe command
  if (commandName === 'snipe') {
    const target = interaction.options.getUser('target');
    
    if (target.id === interaction.user.id) {
      return interaction.reply({ 
        content: 'You can\'t snipe yourself! 😅', 
        ephemeral: true 
      });
    }

    if (target.bot) {
      return interaction.reply({ 
        content: 'You can\'t snipe bots! 🤖', 
        ephemeral: true 
      });
    }

    // Initialize data if needed
    if (!snipeData[interaction.user.id]) {
      snipeData[interaction.user.id] = { sniped: [], snipedBy: [] };
    }
    if (!snipeData[target.id]) {
      snipeData[target.id] = { sniped: [], snipedBy: [] };
    }

    // Record the snipe
    snipeData[interaction.user.id].sniped.push(target.id);
    snipeData[target.id].snipedBy.push(interaction.user.id);

    await interaction.reply({ 
      content: `🎯 Successfully sniped ${target.username}! Total snipes: ${snipeData[interaction.user.id].sniped.length}`, 
      ephemeral: true 
    });
  }

  // /snipestats command
  if (commandName === 'snipestats') {
    const target = interaction.options.getUser('user') || interaction.user;
    const data = snipeData[target.id];

    if (!data || (data.sniped.length === 0 && data.snipedBy.length === 0)) {
      return interaction.reply({ 
        content: `${target.username} has no snipe activity yet!`, 
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle(`📊 Snipe Stats for ${target.username}`)
      .addFields(
        { name: '🎯 Total Snipes', value: `${data.sniped.length}`, inline: true },
        { name: '💀 Times Sniped', value: `${data.snipedBy.length}`, inline: true },
        { name: '📈 K/D Ratio', value: `${data.snipedBy.length > 0 ? (data.sniped.length / data.snipedBy.length).toFixed(2) : data.sniped.length}`, inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // /leaderboard command
  if (commandName === 'leaderboard') {
    const type = interaction.options.getString('type') || 'snipers';

    let leaderboard = [];
    
    if (type === 'snipers') {
      // Most snipes
      leaderboard = Object.entries(snipeData)
        .map(([userId, data]) => ({ userId, count: data.sniped.length }))
        .filter(entry => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const embed = new EmbedBuilder()
        .setColor('#4CAF50')
        .setTitle('🏆 TOP SNIPERS LEADERBOARD')
        .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
          leaderboard.map((entry, i) => {
            const user = client.users.cache.get(entry.userId);
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            return `${medal} **${user?.username || 'Unknown'}** - ${entry.count} snipes`;
          }).join('\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: false });
    } else if (type === 'victims') {
      // Most sniped
      leaderboard = Object.entries(snipeData)
        .map(([userId, data]) => ({ userId, count: data.snipedBy.length }))
        .filter(entry => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const embed = new EmbedBuilder()
        .setColor('#F44336')
        .setTitle('💀 MOST SNIPED VICTIMS')
        .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
          leaderboard.map((entry, i) => {
            const user = client.users.cache.get(entry.userId);
            const medal = i === 0 ? '💀' : i === 1 ? '☠️' : i === 2 ? '👻' : `${i + 1}.`;
            return `${medal} **${user?.username || 'Unknown'}** - ${entry.count} times sniped`;
          }).join('\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: false });
    }
  }

  // /help command
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#2196F3')
      .setTitle('🎯 Snipe Bot Commands')
      .setDescription('Track your snipes and dominate the leaderboard! All responses are private (only you can see them).')
      .addFields(
        { name: '/snipe @user', value: 'Log a snipe against the mentioned user' },
        { name: '/snipestats [@user]', value: 'View snipe statistics for yourself or another user' },
        { name: '/leaderboard [type]', value: 'View top snipers or most sniped victims' },
        { name: '/help', value: 'Show this help message' }
      )
      .setFooter({ text: 'All messages are ephemeral - only visible to you!' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// Replace with your bot token
client.login(process.env.DISCORD_TOKEN);
