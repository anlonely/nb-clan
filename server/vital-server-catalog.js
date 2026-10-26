// Shared authoritative static catalog; per-server overrides remain in settings.
export const VITAL_RUST_2X_SERVERS = [
  {
    id: '4',
    name: 'Vital Rust 3X EU Mondays',
    vitalServerId: '4',
    battlemetricsId: '9771776',
    schedule: 'weekly_monday_and_force',
    wipeTimeZone: 'Europe/London',
    wipeHourLocal: 14,
    wipeMinuteLocal: 0,
    forceWipeHourLocal: 19,
    forceWipeMinuteLocal: 0,
    directConnect: 'client.connect eu-mondays.vitalrust.com:28014',
    vipUrl: 'https://store.vitalrust.com/package/vip-eu-3x'
  },
  {
    id: '16',
    name: 'Vital Rust 2X EU Monthly',
    vitalServerId: '16',
    battlemetricsId: '29566604',
    schedule: 'monthly_force_with_intermediate',
    wipeTimeZone: 'Europe/London',
    wipeHourLocal: 19,
    wipeMinuteLocal: 0,
    intermediateWipeHourLocal: 17,
    intermediateWipeMinuteLocal: 0,
    // Official A2S RULES: one week before force, not three weeks after it.
    intermediateWeeksBeforeForce: [1],
    directConnect: 'client.connect eu-monthly.vitalrust.com:28014',
    vipUrl: 'https://store.vitalrust.com/package/vip-eu-2x-servers-mon'
  },
  {
    id: '19',
    name: 'Vital Rust 2X EU Medium',
    vitalServerId: '19',
    battlemetricsId: '32032048',
    schedule: 'monthly_weeks',
    wipeTimeZone: 'Europe/London',
    wipeWeeks: [1, 3],
    wipeHoursLocalByWeek: { 1: 19, 3: 17 },
    wipeMinuteLocal: 0,
    directConnect: 'client.connect eu-medium.vitalrust.com:28014',
    vipUrl: 'https://store.vitalrust.com/package/vip-eu-2x-servers-mon'
  },
  {
    id: '23',
    name: 'Vital Rust 2X US Monthly',
    vitalServerId: '23',
    battlemetricsId: '36933209',
    status: 'hidden',
    schedule: 'monthly_force_with_intermediate',
    wipeTimeZone: 'America/New_York',
    wipeHourLocal: 14,
    wipeMinuteLocal: 0,
    intermediateWipeHourLocal: 17,
    intermediateWipeMinuteLocal: 0,
    intermediateWeeksBeforeForce: [1],
    directConnect: 'client.connect 168.100.163.73:28014',
    vipUrl: 'https://store.vitalrust.com/package/vip-us-monthly'
  }
];
