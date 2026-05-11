import { Bot, BrainCircuit, MessageSquare } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export function AIRecruiter() {
  const candidateRows = [
    { name: "Ahmed K.", photo: "/team-avatars/ahmed.webp", elevated: false },
    { name: "Bilal M.", photo: "/team-avatars/bilal.webp", elevated: true },
    { name: "Sara N.", photo: "/team-avatars/sara-n.webp", elevated: false },
  ];

  return (
    <section className="bg-white px-6 py-0 md:px-10">
      <div className="mx-auto max-w-[1400px]">
        <div className="overflow-hidden rounded-3xl bg-[#9886fe] px-6 py-12 md:px-14 md:py-[72px]">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_56px_1fr] lg:gap-0">
            <div className="flex flex-col lg:pr-12">
              <div className="mb-5 inline-flex items-center gap-2.5">
                <span className="block h-px w-6 bg-remotiv-green" />
                <span className="font-sans text-[0.6rem] font-bold uppercase tracking-[0.22em] text-white/90">
                  AI-Powered Matching
                </span>
              </div>

              <h2 className="font-heading text-[clamp(1.6rem,7vw,3.2rem)] font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-white break-words">
                Meet Remotiv AI:
                <br />
                <em className="block not-italic text-remotiv-green">Your Always-On</em>
                <br />
                Recruiter
              </h2>

              <p className="mt-4 max-w-[400px] font-sans text-[0.95rem] font-normal leading-[1.75] text-white/65">
                Just tell us the role. Our AI scans 1M+ verified profiles and delivers a shortlist
                of pre-vetted candidates — within 24 hours.
              </p>
              <p className="mt-3 mb-9 max-w-[380px] font-sans text-[0.88rem] font-normal leading-[1.7] text-white/40">
                At a fraction of what a traditional recruiter charges.
              </p>

              <Link
                href="/ai-matching"
                className="inline-flex w-fit items-center gap-2 rounded-lg bg-remotiv-green px-[30px] py-[15px] font-heading text-[0.78rem] font-bold uppercase tracking-[0.1em] text-[#453e40] transition-colors duration-200 hover:bg-[#3bc495]"
              >
                See How It Works →
              </Link>
            </div>

            <div className="hidden lg:flex lg:flex-col lg:items-center lg:gap-3 lg:self-stretch">
              <div className="flex-1 border-l border-dashed border-white/20" />
              <div className="flex size-9 items-center justify-center rounded-lg border-[1.5px] border-white/20 bg-white/[0.08] text-white">
                <BrainCircuit className="size-4" />
              </div>
              <div className="flex-1 border-l border-dashed border-white/20" />
              <div className="flex size-9 items-center justify-center rounded-lg border-[1.5px] border-white/20 bg-white/[0.08] text-white">
                <MessageSquare className="size-4" />
              </div>
              <div className="flex-1 border-l border-dashed border-white/20" />
              <div className="flex size-9 items-center justify-center rounded-lg border-[1.5px] border-white/20 bg-white/[0.08] text-white">
                <Bot className="size-4" />
              </div>
              <div className="flex-1 border-l border-dashed border-white/20" />
            </div>

            <div className="flex w-full min-w-0 flex-col gap-3.5 overflow-hidden lg:pl-12">
              <div className="flex w-full min-w-0 items-start gap-3">
                <Image
                  src="/team-avatars/recruiter.webp"
                  alt=""
                  width={44}
                  height={44}
                  className="size-11 shrink-0 rounded-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <span className="mb-1.5 block font-heading text-[0.6rem] font-bold uppercase tracking-[0.1em] text-white">
                    Recruiter
                  </span>
                  <div className="max-w-full overflow-hidden break-words rounded-[4px_22px_22px_22px] bg-white px-5 py-4">
                    <p className="whitespace-normal break-words font-sans text-[0.9rem] font-medium leading-[1.5] text-[#111]">
                      Send me candidates interested in{" "}
                      <span className="rounded bg-[#fef08a] px-1.5 py-0.5 text-[0.58rem] font-bold uppercase tracking-[0.06em] text-[#713f12]">
                        React Dev
                      </span>{" "}
                      with experience in{" "}
                      <span className="rounded bg-[#e0e7ff] px-1.5 py-0.5 text-[0.58rem] font-bold uppercase tracking-[0.06em] text-[#3730a3]">
                        Next.js
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex w-full min-w-0 flex-col items-end">
                <span className="mb-1.5 hidden font-heading text-[0.6rem] font-bold uppercase tracking-[0.12em] text-white/40 sm:block">
                  Remotiv<em className="not-italic text-remotiv-green">:ai</em>
                </span>
                <div className="max-w-[90%] overflow-hidden break-words rounded-[22px_4px_22px_22px] bg-remotiv-green px-5 py-4">
                  <p className="whitespace-normal break-words font-sans text-[0.85rem] font-semibold leading-[1.45] text-[#453e40]">
                    Absolutely! Sending you a shortlist of top candidates now.
                  </p>
                </div>
              </div>

              <div
                aria-hidden="true"
                className="flex w-full min-w-0 items-end gap-2 overflow-x-hidden"
              >
                <Image
                  src="/team-avatars/searching-1.webp"
                  alt=""
                  width={36}
                  height={36}
                  className="size-9 shrink-0 rounded-full object-cover"
                />
                <Image
                  src="/team-avatars/searching-2.webp"
                  alt=""
                  width={28}
                  height={28}
                  className="hidden size-7 shrink-0 rounded-full object-cover sm:inline-block"
                  style={{ marginBottom: "10px" }}
                />
                <Image
                  src="/team-avatars/searching-3.webp"
                  alt=""
                  width={44}
                  height={44}
                  className="size-11 shrink-0 rounded-full object-cover"
                  style={{ marginBottom: "2px" }}
                />
                <Image
                  src="/team-avatars/searching-4.webp"
                  alt=""
                  width={32}
                  height={32}
                  className="size-8 shrink-0 rounded-full object-cover"
                  style={{ marginBottom: "14px" }}
                />
                <Image
                  src="/team-avatars/searching-5.webp"
                  alt=""
                  width={42}
                  height={42}
                  className="size-[42px] shrink-0 rounded-full object-cover"
                />
                <Image
                  src="/team-avatars/searching-6.webp"
                  alt=""
                  width={26}
                  height={26}
                  className="hidden size-[26px] shrink-0 rounded-full object-cover sm:inline-block"
                  style={{ marginBottom: "16px" }}
                />
                <Image
                  src="/team-avatars/searching-7.webp"
                  alt=""
                  width={38}
                  height={38}
                  className="size-[38px] shrink-0 rounded-full object-cover"
                  style={{ marginBottom: "4px" }}
                />
                <span className="ml-2 hidden font-sans text-[0.58rem] font-normal italic uppercase tracking-[0.16em] text-white/30 sm:inline-block">
                  searching...
                </span>
              </div>

              <div className="w-full max-w-full overflow-hidden rounded-2xl bg-remotiv-bg px-[18px] pt-5 pb-4">
                <h3 className="mb-4 whitespace-normal break-words font-heading text-[0.82rem] font-bold uppercase tracking-tight text-[#1a1a1a]">
                  Your Qualified Candidate Review List
                </h3>
                <div className="flex flex-col">
                  {candidateRows.map((row) => (
                    <div
                      key={row.name}
                      className={
                        row.elevated
                          ? "relative -mx-1.5 -my-0.5 z-10 rounded-xl bg-white px-4 py-3.5"
                          : "px-3 py-2.5"
                      }
                    >
                      {row.elevated && (
                        <span className="absolute -bottom-3 left-3.5 inline-block rounded-full bg-remotiv-bg px-3 py-1 font-heading text-[0.52rem] font-bold uppercase tracking-[0.08em] text-[#111]">
                          Recruiter
                        </span>
                      )}
                      <div className="flex w-full min-w-0 items-center gap-3">
                        <Image
                          src={row.photo}
                          alt={row.name}
                          width={36}
                          height={36}
                          className="size-9 shrink-0 rounded-full object-cover ring-2 ring-black/[0.06]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-sans text-[0.8rem] font-bold text-[#111]">
                              {row.name}
                            </span>
                            <span className="rounded-full border border-[#a7f3d0] bg-[#d1fae5] px-2 py-0.5 text-[0.52rem] font-bold uppercase tracking-[0.06em] text-[#065f46]">
                              Interested
                            </span>
                          </div>
                          <p className="mt-0.5 font-sans text-[0.7rem] text-[#777]">
                            Experience in{" "}
                            <span className="rounded bg-[#e5e7eb] px-1 py-0.5 text-[0.58rem] font-bold text-[#374151]">
                              Next.js
                            </span>
                          </p>
                        </div>
                        <button
                          type="button"
                          aria-label={`Approve ${row.name}`}
                          className="size-[26px] shrink-0 rounded-full border-[1.5px] border-remotiv-green text-[0.7rem] text-remotiv-green transition-colors hover:bg-remotiv-green hover:text-white"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          aria-label={`Reject ${row.name}`}
                          className="size-[26px] shrink-0 rounded-full border-[1.5px] border-red-500 text-[0.7rem] text-red-500 transition-colors hover:bg-red-500 hover:text-white"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
