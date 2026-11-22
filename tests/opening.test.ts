import { describe, expect, it } from 'vitest';
import { suggestRoute } from '../src/sim/autoroute';
import { OBJECTIVES } from '../src/sim/objectives';
import { SAVE_VERSION, fromSave, toSave } from '../src/sim/save';
import { newGame } from '../src/sim/sim';
import { SEED, claimRailhead, must, runTicks } from './helpers';

describe('the opening: the line comes first, the bank comes with it', () => {
  it('the first objective is met by signing a contract, not by borrowing', () => {
    const s = newGame(SEED);
    expect(OBJECTIVES[0].title).toBe('Sign for a line to the Eureka claim');
    must(s, { type: 'borrow', amount: 30000 });
    runTicks(s, 2);
    expect(s.objective).toBe(0);
    must(s, { type: 'buildLine', way: suggestRoute(s, s.nodes[0], claimRailhead(s))! });
    runTicks(s, 1);
    expect(s.objective).toBe(1);
  });

  it('a version 1 save that had only been to the bank reopens on the first step', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 30000 });
    const file = toSave(s, 0);
    file.version = 1; (file.state as { objective: number }).objective = 1; // "Raise the capital" done, no track yet
    const back = fromSave(file);
    expect(back.objective).toBe(0);
    expect(SAVE_VERSION).toBe(2);
  });

  it('a version 1 save with the contract already signed moves straight on to the railhead', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 30000 });
    must(s, { type: 'buildLine', way: suggestRoute(s, s.nodes[0], claimRailhead(s))! });
    const file = toSave(s, 0);
    file.version = 1; (file.state as { objective: number }).objective = 1;
    const back = fromSave(file);
    runTicks(back, 1);
    expect(back.objective).toBe(1);
    expect(OBJECTIVES[back.objective].title).toBe('Bring the railhead to the claim');
  });
});
