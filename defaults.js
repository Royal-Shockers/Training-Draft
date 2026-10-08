// Starter lists. The site copies these into your database the first time you set it up.
const BRAWLERS = ["Shelly","Colt","Bull","Brock","Rico","Spike","Barley","Jessie","Nita","Dynamike","El Primo",
 "Mortis","Crow","Poco","Bo","Piper","Pam","Tara","Darryl","Penny","Frank","Gene","Tick","Leon","Rosa","Carl",
 "Bibi","8-Bit","Sandy","Bea","Emz","Mr. P","Max","Jacky","Gale","Nani","Sprout","Surge","Colette","Amber","Lou",
 "Byron","Edgar","Ruffs","Stu","Belle","Squeak","Grom","Buzz","Griff","Ash","Meg","Lola","Fang","Eve","Janet",
 "Bonnie","Otis","Sam","Gus","Buster","Chester","Gray","Mandy","R-T","Willow","Maisie","Hank","Cordelius","Doug",
 "Pearl","Chuck","Charlie","Mico","Kit","Larry & Lawrie","Melodie","Angelo","Draco","Lily","Berry","Clancy","Moe",
 "Kenji","Shade","Juju","Meeple","Ollie","Lumi","Finx","Jae-Yong"];
const MODES = ["Gem Grab","Brawl Ball","Heist","Bounty","Knockout","Hot Zone"];
const MAPS = [["Hard Rock Mine","Gem Grab"],["Crystal Arcade","Gem Grab"],["Undermine","Gem Grab"],["Double Swoosh","Gem Grab"],
 ["Backyard Bowl","Brawl Ball"],["Pinball Dreams","Brawl Ball"],["Center Stage","Brawl Ball"],["Sneaky Fields","Brawl Ball"],["Triple Dribble","Brawl Ball"],
 ["Safe Zone","Heist"],["Hot Potato","Heist"],["Kaboom Canyon","Heist"],["Bridge Too Far","Heist"],
 ["Shooting Star","Bounty"],["Hideout","Bounty"],["Layer Cake","Bounty"],["Dry Season","Bounty"],
 ["Belle's Rock","Knockout"],["Flaring Phoenix","Knockout"],["Out in the Open","Knockout"],["Goldarm Gulch","Knockout"],["New Horizons","Knockout"],
 ["Dueling Beetles","Hot Zone"],["Open Business","Hot Zone"],["Parallel Plays","Hot Zone"],["Ring of Fire","Hot Zone"]];

export function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

export function defaultLists() {
  const modes = MODES.map(n => ({ id: slug(n), name: n }));
  return {
    brawlers: BRAWLERS.map(n => ({ id: slug(n), name: n })),
    modes,
    maps: MAPS.map(([n, m]) => ({ id: slug(n), name: n, mode: slug(m) })),
  };
}
