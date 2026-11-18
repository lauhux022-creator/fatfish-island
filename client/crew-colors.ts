const crewColors = new Map([
  ['bot-1', '#bb613d'],
  ['bot-2', '#287f9c'],
  ['bot-3', '#79528a'],
]);

export function crewColor(id: string): string {
  return crewColors.get(id) ?? '#207069';
}
