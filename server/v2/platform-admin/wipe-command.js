export const DISCORD_WIPE_COMMAND_ID = 'wipe';
export const WIPE_SIGNUP_MODES = Object.freeze(['member_required', 'discord_only']);

// Saved configurations used two rows for the same feature. Project them into
// one command without changing persisted card references or attendance records.
export function normalizeDiscordWipeConfig(input) {
  if (!input || !Array.isArray(input.commands)) return input;
  // Invalid duplicate rows remain visible to the config validator; the legacy
  // merge applies only to the two distinct, previously supported IDs.
  if (['wipe', 'signup_card'].some(id => input.commands.filter(row => row.id === id).length > 1)) return input;
  const wipe = input.commands.find(row => row.id === DISCORD_WIPE_COMMAND_ID);
  const card = input.commands.find(row => row.id === 'signup_card');
  if (!wipe && !card) return input;
  const source = wipe || card;
  const rawMode = wipe?.signupMode ?? card?.signupMode ?? 'member_required';
  const signupMode = ({ discord: 'discord_only', member: 'member_required', registered_member: 'member_required' })[rawMode] || rawMode;
  const command = {
    ...card, ...wipe, id: DISCORD_WIPE_COMMAND_ID,
    name: !source.name || ['Wipe 登记', 'Wipe Sign-up', '报名卡片', 'Wipe 报名'].includes(source.name) ? 'wipe-react' : source.name,
    type: 'event_command', slashCommand: !wipe?.slashCommand || ['wipe', '/wipe'].includes(wipe.slashCommand) ? 'wipe-react' : wipe.slashCommand.replace(/^\//, ''),
    signupMode, enabled: wipe?.enabled === true || card?.enabled === true
  };
  const commands = [];
  let inserted = false;
  for (const row of input.commands) {
    if (row.id === DISCORD_WIPE_COMMAND_ID || row.id === 'signup_card') {
      if (!inserted) commands.push(command);
      inserted = true;
    } else commands.push(row);
  }
  return {
    ...input, commands,
    ...(Array.isArray(input.targets) ? { targets: input.targets.map(target => ({
      ...target,
      ...(Array.isArray(target.enabledCommandIds) ? { enabledCommandIds: [...new Set(target.enabledCommandIds.map(id => id === 'signup_card' ? DISCORD_WIPE_COMMAND_ID : id))] } : {})
    })) } : {})
  };
}
