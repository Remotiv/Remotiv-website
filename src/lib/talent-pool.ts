export type TalentType = "Eng" | "Design" | "Data" | "PM" | "Ops";

export interface TalentExperience {
  title: string;
  company: string;
  dates: string;
  skills: string[];
}

export interface Talent {
  id: number;
  name: string;
  initials: string;
  role: string;
  type: TalentType;
  skills: string[];
  salary: string;
  location: string;
  exp: string;
  available: boolean;
  score: number;
  highlights: string[];
  bio: string;
  fullTime: boolean;
  partTime: boolean;
  remote: boolean;
  education: string;
  lastActive: string;
  experience: TalentExperience[];
  github: string | null;
  linkedin: string;
  why?: string;
}

export interface RoleConfig {
  label: string;
  color: string;
  border: string;
  background: string;
}

export const ROLE_CONFIG: Record<TalentType, RoleConfig> = {
  Eng: {
    label: "Engineering",
    color: "#3b82f6",
    border: "rgba(59,130,246,0.3)",
    background: "rgba(59,130,246,0.08)",
  },
  Design: {
    label: "Design",
    color: "#a855f7",
    border: "rgba(168,85,247,0.3)",
    background: "rgba(168,85,247,0.08)",
  },
  Data: {
    label: "Data",
    color: "#f59e0b",
    border: "rgba(245,158,11,0.3)",
    background: "rgba(245,158,11,0.08)",
  },
  PM: {
    label: "Product",
    color: "#10b981",
    border: "rgba(16,185,129,0.3)",
    background: "rgba(16,185,129,0.08)",
  },
  Ops: {
    label: "Operations",
    color: "#ef4444",
    border: "rgba(239,68,68,0.3)",
    background: "rgba(239,68,68,0.08)",
  },
};

export const TALENT_POOL: Talent[] = [
  {
    id: 101,
    name: "Hamza Raza",
    initials: "HR",
    role: "Senior Full Stack Developer",
    type: "Eng",
    skills: ["React", "Node.js", "TypeScript", "PostgreSQL", "AWS"],
    salary: "$85K",
    location: "Lahore, Pakistan",
    exp: "6 years",
    available: true,
    score: 97,
    highlights: ["Led SaaS platform rebuild", "50M req/day API", "Series B fintech lead"],
    bio: "6 years building scalable SaaS products. Specialises in React/Node.js full-stack architecture. Previously led frontend at a Series B fintech startup. Strong communicator, comfortable in async remote environments.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "LUMS — BS Computer Science",
    lastActive: "Today",
    experience: [
      {
        title: "Senior Full Stack Engineer",
        company: "Finja (Fintech)",
        dates: "2022–Present · 2 yrs",
        skills: ["React", "Node.js", "AWS"],
      },
      {
        title: "Full Stack Developer",
        company: "Systems Ltd",
        dates: "2019–2022 · 3 yrs",
        skills: ["TypeScript", "PostgreSQL"],
      },
    ],
    github: "github.com/hamzaraza",
    linkedin: "linkedin.com/in/hamzaraza",
    why: "Strong React/Node.js expertise with Series B fintech leadership and async remote experience.",
  },
  {
    id: 102,
    name: "Aisha Noor",
    initials: "AN",
    role: "UI/UX Designer",
    type: "Design",
    skills: ["Figma", "User Research", "Prototyping", "Design Systems", "Webflow"],
    salary: "$65K",
    location: "Karachi, Pakistan",
    exp: "4 years",
    available: true,
    score: 91,
    highlights: [
      "200k+ user interfaces shipped",
      "Design system for 3 products",
      "Accessibility-first approach",
    ],
    bio: "4 years designing intuitive digital products. Has shipped interfaces used by 200k+ users. Expert in design systems and component libraries. Passionate about accessibility and inclusive design.",
    fullTime: true,
    partTime: true,
    remote: true,
    education: "NED University — BS Industrial Design",
    lastActive: "Yesterday",
    experience: [
      {
        title: "Lead Product Designer",
        company: "Airlift (YC S19)",
        dates: "2021–Present · 3 yrs",
        skills: ["Figma", "Design Systems"],
      },
      {
        title: "UX Designer",
        company: "Careem",
        dates: "2020–2021 · 1 yr",
        skills: ["User Research", "Prototyping"],
      },
    ],
    github: null,
    linkedin: "linkedin.com/in/aishanoor",
    why: "Shipped interfaces at scale with design-system and accessibility expertise.",
  },
  {
    id: 103,
    name: "Bilal Ahmed",
    initials: "BA",
    role: "DevOps Engineer",
    type: "Eng",
    skills: ["AWS", "Kubernetes", "Terraform", "CI/CD", "Docker"],
    salary: "$75K",
    location: "Islamabad, Pakistan",
    exp: "5 years",
    available: true,
    score: 89,
    highlights: [
      "70% faster deployments",
      "Multi-region AWS architecture",
      "Certified Solutions Architect",
    ],
    bio: "5 years in cloud infrastructure and DevOps. Built CI/CD pipelines reducing deployment time by 70%. Certified AWS Solutions Architect. Experienced with multi-region deployments at scale.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "FAST NUCES — BS Computer Science",
    lastActive: "2 days ago",
    experience: [
      {
        title: "Senior DevOps Engineer",
        company: "Netsol Technologies",
        dates: "2022–Present · 2 yrs",
        skills: ["Kubernetes", "Terraform"],
      },
      {
        title: "Cloud Engineer",
        company: "10Pearls",
        dates: "2019–2022 · 3 yrs",
        skills: ["AWS", "CI/CD"],
      },
    ],
    github: "github.com/bilalahmed",
    linkedin: "linkedin.com/in/bilalahmed",
    why: "Certified AWS architect with multi-region infrastructure and CI/CD pipeline expertise.",
  },
  {
    id: 104,
    name: "Sara Malik",
    initials: "SM",
    role: "Data Scientist",
    type: "Data",
    skills: ["Python", "TensorFlow", "SQL", "Tableau", "NLP"],
    salary: "$70K",
    location: "Lahore, Pakistan",
    exp: "3 years",
    available: false,
    score: 85,
    highlights: [
      "Recommendation engine with +12% CVR",
      "Published ML research",
      "Predictive models in healthtech",
    ],
    bio: "3 years in data science with a focus on NLP and predictive modelling. Published research in machine learning. Built recommendation engines with measurable uplift in e-commerce conversion.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "LUMS — MS Data Science",
    lastActive: "3 days ago",
    experience: [
      {
        title: "Data Scientist",
        company: "Daraz (Alibaba)",
        dates: "2022–Present · 2 yrs",
        skills: ["Python", "NLP", "TensorFlow"],
      },
      {
        title: "ML Engineer",
        company: "Technado",
        dates: "2021–2022 · 1 yr",
        skills: ["SQL", "Tableau"],
      },
    ],
    github: "github.com/saramalik",
    linkedin: "linkedin.com/in/saramalik",
    why: "Proven recommendation engine delivery with measurable conversion uplift.",
  },
  {
    id: 105,
    name: "Umar Farooq",
    initials: "UF",
    role: "Mobile Developer (React Native)",
    type: "Eng",
    skills: ["React Native", "iOS", "Android", "Firebase", "Redux"],
    salary: "$78K",
    location: "Karachi, Pakistan",
    exp: "5 years",
    available: true,
    score: 93,
    highlights: [
      "8 apps on App Store & Play Store",
      "Native module bridging expert",
      "50k+ DAU app delivered",
    ],
    bio: "5 years building cross-platform mobile apps. Published 8 apps on App Store and Play Store. Deep expertise in React Native performance optimisation and native module bridging.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "IBA Karachi — BS Computer Science",
    lastActive: "Today",
    experience: [
      {
        title: "Senior Mobile Developer",
        company: "Bykea",
        dates: "2021–Present · 3 yrs",
        skills: ["React Native", "Redux"],
      },
      {
        title: "Mobile Developer",
        company: "Arbisoft",
        dates: "2019–2021 · 2 yrs",
        skills: ["iOS", "Android", "Firebase"],
      },
    ],
    github: "github.com/umarfarooq",
    linkedin: "linkedin.com/in/umarfarooq",
    why: "Eight shipped apps and proven React Native performance track record.",
  },
  {
    id: 106,
    name: "Fatima Shah",
    initials: "FS",
    role: "Backend Engineer",
    type: "Eng",
    skills: ["Python", "Django", "FastAPI", "Redis", "PostgreSQL"],
    salary: "$82K",
    location: "Islamabad, Pakistan",
    exp: "7 years",
    available: false,
    score: 88,
    highlights: ["50M req/day APIs built", "Fintech & healthtech background", "System design expert"],
    bio: "7 years backend engineering across fintech and healthtech. Built high-throughput APIs handling 50M+ requests/day. Strong background in system design and database optimisation.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "COMSATS — BS Software Engineering",
    lastActive: "1 week ago",
    experience: [
      {
        title: "Principal Backend Engineer",
        company: "Meezan Bank Digital",
        dates: "2020–Present · 4 yrs",
        skills: ["FastAPI", "PostgreSQL", "Redis"],
      },
      {
        title: "Backend Developer",
        company: "Folio3",
        dates: "2017–2020 · 3 yrs",
        skills: ["Django", "Python"],
      },
    ],
    github: "github.com/fatimashah",
    linkedin: "linkedin.com/in/fatimashah",
    why: "High-throughput API experience with fintech and system design depth.",
  },
  {
    id: 107,
    name: "Zain Ul Abideen",
    initials: "ZA",
    role: "Frontend Developer",
    type: "Eng",
    skills: ["Vue.js", "React", "CSS", "GraphQL", "Storybook"],
    salary: "$60K",
    location: "Lahore, Pakistan",
    exp: "3 years",
    available: true,
    score: 80,
    highlights: [
      "Pixel-perfect UI specialist",
      "Storybook component library author",
      "Figma-to-code expert",
    ],
    bio: "3 years building beautiful, performant frontends. Obsessed with pixel-perfect UI and micro-interactions. Experienced with design-developer handoff workflows using Figma and Storybook.",
    fullTime: true,
    partTime: true,
    remote: true,
    education: "UET Lahore — BS Computer Engineering",
    lastActive: "Today",
    experience: [
      {
        title: "Frontend Developer",
        company: "Contour Software",
        dates: "2022–Present · 2 yrs",
        skills: ["Vue.js", "Storybook"],
      },
      {
        title: "Junior Frontend Dev",
        company: "Epihub",
        dates: "2021–2022 · 1 yr",
        skills: ["React", "GraphQL"],
      },
    ],
    github: "github.com/zainabideen",
    linkedin: "linkedin.com/in/zainabideen",
    why: "Strong pixel-perfect UI and design-handoff workflow expertise.",
  },
  {
    id: 108,
    name: "Mariam Tariq",
    initials: "MT",
    role: "Product Manager",
    type: "PM",
    skills: ["Product Strategy", "Agile", "Jira", "Roadmapping", "Analytics"],
    salary: "$68K",
    location: "Karachi, Pakistan",
    exp: "5 years",
    available: false,
    score: 82,
    highlights: [
      "Two 0-to-1 product launches",
      "B2B SaaS specialist",
      "OKR & data-driven PM",
    ],
    bio: "5 years in product management across B2B SaaS. Led two 0-to-1 product launches. Skilled at aligning engineering and business stakeholders. Strong data-driven decision-making background.",
    fullTime: true,
    partTime: false,
    remote: true,
    education: "IBA Karachi — MBA",
    lastActive: "4 days ago",
    experience: [
      {
        title: "Senior Product Manager",
        company: "Bazaar Technologies",
        dates: "2022–Present · 2 yrs",
        skills: ["Roadmapping", "Analytics"],
      },
      {
        title: "Product Manager",
        company: "Zameen.com",
        dates: "2019–2022 · 3 yrs",
        skills: ["Agile", "Jira"],
      },
    ],
    github: null,
    linkedin: "linkedin.com/in/mariamtariq",
    why: "Two 0-to-1 launches with a data-driven PM approach in B2B SaaS.",
  },
];
