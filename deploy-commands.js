import { REST, Routes } from 'discord.js';
import { commands } from './src/commands.js';
import { config } from './src/config.js';

const rest = new REST({ version: '10' }).setToken(config.token);
const body = commands.map((command) => command.data.toJSON());

if (config.guildId) {
  console.log(`Deploying ${body.length} command(s) to test guild ${config.guildId}...`);
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body }
  );
} else {
  console.log(`Deploying ${body.length} command(s) globally...`);
  await rest.put(Routes.applicationCommands(config.clientId), { body });
}

console.log('Commands deployed successfully.');
