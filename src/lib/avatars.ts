// Available avatar counts (stored in /public/avatars/)
const MALE_AVATAR_COUNT = 20;
const FEMALE_AVATAR_COUNT = 15;

// Common names for gender detection
const FEMALE_NAMES = new Set([
  'aisha', 'fatima', 'maria', 'zainab', 'sara', 'sarah', 'amina', 'amna', 'ayesha',
  'hina', 'nida', 'rabia', 'sana', 'samia', 'samina', 'tahira', 'fariha', 'farah',
  'farzana', 'humera', 'nadia', 'noor', 'rida', 'shabana', 'shazia', 'sobia',
  'tanveer', 'yasmin', 'zara', 'zoya', 'aliya', 'anum', 'arooj', 'asma', 'beenish',
  'bushra', 'erum', 'huma', 'iqra', 'kanwal', 'kiran', 'laraib', 'mahnoor', 'maleeha',
  'mariam', 'mehak', 'mehreen', 'mubashira', 'nazia', 'nimra', 'rabail', 'rafia',
  'rahima', 'rakhshanda', 'roohi', 'rubina', 'rukhsana', 'saba', 'safia', 'salma',
  'samreen', 'shaista', 'shumaila', 'somia', 'sundas', 'sundus', 'tabinda', 'tabassum',
  'urooj', 'uzma', 'wajiha', 'zahra', 'zeba', 'zeenat', 'zubaida',
  'jane', 'mary', 'jennifer', 'linda', 'patricia', 'elizabeth', 'barbara', 'susan',
  'jessica', 'helen', 'nancy', 'lisa', 'betty', 'margaret', 'sandra', 'ashley',
  'kimberly', 'emily', 'donna', 'michelle', 'carol', 'amanda', 'melissa', 'deborah',
  'stephanie', 'rebecca', 'laura', 'sharon', 'cynthia', 'kathleen', 'amy', 'shirley',
  'angela', 'anna', 'brenda', 'pamela', 'emma', 'nicole', 'samantha', 'katherine',
  'christine', 'debra', 'rachel', 'catherine', 'olivia', 'sophia', 'isabella', 'mia',
  'charlotte', 'amelia', 'harper', 'evelyn', 'abigail', 'ella', 'avery', 'ava',
  'syeda', 'ifrah', 'sehar', 'meher', 'maham', 'eman',
]);

const MALE_NAMES = new Set([
  'ahmed', 'ali', 'hassan', 'hussain', 'muhammad', 'mohammad', 'mohammed', 'usman',
  'umar', 'omar', 'bilal', 'fahad', 'farhan', 'faisal', 'haroon', 'imran', 'irfan',
  'jawad', 'kamran', 'khalid', 'majid', 'naveed', 'nadeem', 'rashid', 'saad',
  'salman', 'shahid', 'tariq', 'waleed', 'wasim', 'yasir', 'zafar', 'zain', 'zeeshan',
  'awais', 'abdullah', 'arsalan', 'asad', 'asim', 'ayan', 'azhar', 'babar', 'danish',
  'fawad', 'hamza', 'haris', 'haseeb', 'hashim', 'iqbal', 'junaid', 'kashif', 'mansoor',
  'mubashir', 'mudassir', 'mustafa', 'nasir', 'noman', 'qasim', 'raheel', 'rehan',
  'rizwan', 'saeed', 'shahzad', 'sohail', 'taimoor', 'tayyab', 'waqar',
  'yahya', 'younus', 'zahid', 'arsum',
  'james', 'john', 'robert', 'michael', 'william', 'david', 'richard', 'joseph',
  'thomas', 'charles', 'christopher', 'daniel', 'matthew', 'anthony', 'mark', 'donald',
  'steven', 'paul', 'andrew', 'joshua', 'kenneth', 'kevin', 'brian', 'george', 'edward',
  'ronald', 'timothy', 'jason', 'jeffrey', 'ryan', 'jacob', 'gary', 'nicholas', 'eric',
  'jonathan', 'stephen', 'larry', 'justin', 'scott', 'brandon', 'benjamin', 'samuel',
  'frank', 'gregory', 'raymond', 'alexander', 'patrick', 'jack', 'dennis', 'jerry',
  'tyler', 'aaron', 'henry', 'douglas', 'peter', 'noah', 'liam', 'mason', 'lucas',
  'oliver', 'ethan', 'logan', 'jackson', 'sebastian', 'aiden', 'kyler', 'dean',
]);

export type Gender = 'male' | 'female' | 'unknown';

/**
 * Detects gender from first name.
 * Returns 'male', 'female', or 'unknown'.
 */
export function detectGender(firstName: string | null | undefined): Gender {
  if (!firstName) return 'unknown';
  const normalized = firstName.toLowerCase().trim().split(/\s+/)[0]; // first word only
  if (FEMALE_NAMES.has(normalized)) return 'female';
  if (MALE_NAMES.has(normalized)) return 'male';
  return 'unknown';
}

/**
 * Hash a string to a number (deterministic, simple).
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 32-bit
  }
  return Math.abs(hash);
}

/**
 * Get a deterministic avatar URL for a candidate.
 * Same name always returns same avatar.
 */
export function getAvatarUrl(firstName: string | null, lastName: string | null): string {
  const fullName = `${firstName ?? ''} ${lastName ?? ''}`.trim() || 'unknown';
  const gender = detectGender(firstName);
  const hash = hashString(fullName);

  if (gender === 'female') {
    const num = (hash % FEMALE_AVATAR_COUNT) + 1;
    return `/avatars/female-${String(num).padStart(3, '0')}.png`;
  }

  // Default to male avatars for 'male' and 'unknown' genders
  const num = (hash % MALE_AVATAR_COUNT) + 1;
  return `/avatars/male-${String(num).padStart(3, '0')}.png`;
}

/**
 * Get initials for fallback display.
 */
export function getInitials(firstName: string | null, lastName: string | null): string {
  const fi = firstName?.[0]?.toUpperCase() ?? '';
  const li = lastName?.[0]?.toUpperCase() ?? '';
  return (fi + li) || '?';
}
