import type { SolarBody } from '../contracts';

/** Shared identity, display colours and search aliases for the supported solar system. */
export const solarObjects = [
  { body: 'Sun', label: '太阳', english: 'Sun', aliases: ['日'], color: '#f7d17b' },
  { body: 'Moon', label: '月球', english: 'Moon', aliases: ['月亮', '月'], color: '#d8e1eb' },
  { body: 'Mercury', label: '水星', english: 'Mercury', aliases: ['辰星'], color: '#c4beb2' },
  { body: 'Venus', label: '金星', english: 'Venus', aliases: ['启明星', '长庚星', '太白'], color: '#f2e6c6' },
  { body: 'Mars', label: '火星', english: 'Mars', aliases: ['荧惑'], color: '#e6a080' },
  { body: 'Jupiter', label: '木星', english: 'Jupiter', aliases: ['岁星'], color: '#e5c9a2' },
  { body: 'Saturn', label: '土星', english: 'Saturn', aliases: ['镇星', '填星'], color: '#d8c48d' },
] as const satisfies readonly { body: SolarBody; label: string; english: string; aliases: readonly string[]; color: string }[];
export const solarRadiusKm: Record<SolarBody, number> = { Sun: 695700, Moon: 1737.4, Mercury: 2439.7, Venus: 6051.8, Mars: 3389.5, Jupiter: 69911, Saturn: 58232 };
export const isPlanet = (body: SolarBody): boolean => body !== 'Sun' && body !== 'Moon';
