/**
 * English words that are also names, or that a name can be spelt the same as
 * ("Will", "Baker", "May", "Young", "He", "An", "Long").
 *
 * candidate-name.ts asks this before it removes a name from SPEECH (the live
 * scorer's exchange): a name on this list is removed only where it is clearly
 * used as a name (a greeting, "my name is", the full name), never wherever the
 * word appears, so "I will" and "trained as a baker" stay the candidate's own
 * words whatever the candidate is called.
 *
 * A list, so it has an edge: a name that is a word but is not here is removed
 * wherever it appears, as every surname was before this list existed. That
 * errs towards hiding a name, never towards sending one. Left out on purpose:
 * common surnames that are hardly ever said as words (Smith, Taylor, Carter,
 * Miller, Kim). Add a word when a real name turns out to need it. Lower case,
 * single words only. Pure.
 */
const WORDS: ReadonlySet<string> = new Set(
  [
    "a about above across act add after again against age ago agree ai air all allow almost",
    "alone along already also although always am amber among an and another answer any anyone",
    "anything april archer are area around art as ask at august autumn away back bad baker banks",
    "barber be because become been before began begin behind being believe bell below best",
    "better between big bill bin bird bishop bit black bliss blue bob both brewer bright bring",
    "brook brooks brown build built bull bush business but butler buy by call came can care",
    "carpenter carry case cash cause change charity chase check child chip christian chuck city",
    "clear cliff close come company cook could course crow crystal cut daisy dale dawn day deal",
    "dean decide did do does don done door down drake draw drew drive driver duke dung during",
    "each earl early east easy eat either else end enough eve even ever every fact faith fall",
    "far farmer fast feel few field fight fill final finch find fine fire first five follow for",
    "ford form found four fox frank free from front frost full game gardener gave gene get give",
    "glen go goes gold gone good got grace grant gray great green grey group grow guy ha had",
    "half hand hang hard hart has have he head hear heath help her here high hill hills him his",
    "hit hold holly home honor hope hour house how however hue hung hunter i idea if in into",
    "iris is it its ivy jack job joy judge june just keep kept kind king knew knight know lake",
    "lamb lan lance land large last late later law lead learn least leave left less let life",
    "light like lily line list little live long look lord lot love low made main major make man",
    "many mark marsh mason max may me mean meet men mercy might miles mind miss moon more most",
    "move much must my name near need never new next nice nick night no noble none nor norm",
    "north not note nothing now number odd of off often old olive on once one only open or order",
    "other our out over own page pan park parks pat patience pay pearl penny people person",
    "pierce ping place plan play point pope porter potter power powers price prince put queen",
    "quite rain ran ray read ready real really reason reed rice rich rivers rob rose ruby run",
    "said same sandy sang savage saw say see seem seen sell send set shall sharp she shepherd",
    "short should show side silver since singer sit six skip small snow so some son song soon",
    "sort south spring star start state stay step still stone stop storm strong such sue summer",
    "summers sun sure swan sweet swift take talk team tell ten than thank that the their them",
    "then there these they thing think this those though three through time to today too took",
    "top toward try turn two under until up upon us use very violet wade wait walk walker want",
    "was watch way we weaver week well went were west what when where which while white who",
    "whole why wide wild will win winter winters wise wish with within without wolf woman won",
    "wood woods word work world would write year yes yet you young your",
  ]
    .join(" ")
    .split(" "),
);

/** Whether a name token is also an ordinary English word (any case). */
export function isOrdinaryWord(token: string): boolean {
  return WORDS.has(token.toLowerCase());
}
