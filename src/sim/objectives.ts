import type { GameState } from './types';
import { note } from './economy';

export interface Objective { title: string; why: string; how: string; done: (s: GameState) => boolean; progress?: (s: GameState) => string }

/** The guided path through the first mining-to-market loop. Each step is checked against real simulation state. */
export const OBJECTIVES: Objective[] = [
  { title: 'Sign for a line to the Eureka claim',
    why: 'Your gold is up in the Sawtooth, across the river. Nothing moves until there is a railroad to it.',
    how: 'Draw a railroad from Prosperity to the claim and sign the contract. The bank lends what your cash will not cover.',
    done: (s) => s.jobs.length > 0 || s.edges.length > 0 },
  { title: 'Bring the railhead to the claim',
    why: 'The gangs lay a hundred yards of track a day, and the contract is already paid.',
    how: 'Let the days run; the arrows at the top hurry them. If the line stops short of the claim, draw on from its end.',
    done: (s) => s.stats.reachedClaim,
    progress: (s) => (s.jobs.length ? `Railhead ${Math.round((s.jobs[0].progress / s.jobs[0].length) * 100)}% built` : '') },
  { title: 'Open the Eureka mine',
    why: 'A claim is only a hole in a map until men are digging in it.',
    how: 'Build → Mine, then tap level ground on the claim, near the track. Grade the site first if it is too rough.',
    done: (s) => s.stats.minesBuilt > 0 },
  { title: 'Build a loading platform',
    why: 'Ore has to get from the stockpile into the hoppers.',
    how: 'Build → Loading platform, then tap the track beside the mine.',
    done: (s) => s.stats.platformsBuilt > 0 },
  { title: 'Sell the first shipment',
    why: 'Ore on a stockpile is a cost. Ore sold in the city is a business.',
    how: 'The Prospector runs the service on its own once a platform exists. Follow it from the Trains panel.',
    done: (s) => s.stats.firstSale },
  { title: 'Raise a stamp mill',
    why: 'Eight tons of rock carry one ton of value. Crush it at the mine and haul only what pays.',
    how: 'Build → Stamp mill, then tap level ground beside the mine. The next train carries concentrate.',
    done: (s) => s.stats.firstConcSale },
  { title: 'Close a month in the black',
    why: 'Wages, coal, upkeep and interest are due every day. The line has to earn more than it eats.',
    how: 'Watch the month in Finance. Revenue must beat operating costs and interest.',
    done: (s) => s.stats.profitableMonth },
  { title: 'Improve the works',
    why: 'Profit is for spending on what makes more of it.',
    how: 'Open Works and buy an improvement, or order rolling stock in Trains.',
    done: (s) => s.stats.upgrades > 0 },
  { title: 'Find the second strike',
    why: 'The Eureka will not last for ever. There is talk of silver beyond the western ridge.',
    how: 'Survey → tap the rumoured ground to prospect it, file the claim, and decide whether the ridge is worth crossing.',
    done: (s) => s.stats.minesBuilt > 1 },
];

export function tickObjectives(s: GameState) {
  while (s.objective < OBJECTIVES.length && OBJECTIVES[s.objective].done(s)) {
    note(s, 'good', `Done: ${OBJECTIVES[s.objective].title}.`);
    s.events.push({ type: 'objective', index: s.objective });
    s.objective++;
  }
}
