import { Footer } from "@/components/footer";
import { AIRecruiter } from "@/components/home/ai-recruiter";
import { BrowseRoles } from "@/components/home/browse-roles";
import { CtaInquiry } from "@/components/home/cta-inquiry";
import { Hero } from "@/components/home/hero";
import heroStyles from "@/components/home/hero.module.css";
import { HowItWorks } from "@/components/home/how-it-works";
import { PartnerMarquee } from "@/components/home/partner-marquee";
import { StatsCards } from "@/components/home/stats-cards";
import { StatsCircles } from "@/components/home/stats-circles";
import { Testimonials } from "@/components/home/testimonials";
import { VettingProcess } from "@/components/home/vetting-process";
import { WhoWeHelp } from "@/components/home/who-we-help";
import { WhyRemotiv } from "@/components/home/why-remotiv";
import { Navbar } from "@/components/navbar";

export default function Home() {
  return (
    <>
      {/* Navbar + Hero share one gridded backdrop on the homepage. The
       * wrapper class is module-scoped, so other pages that render
       * <Navbar /> on its own get no grid. */}
      <div className={heroStyles.heroZone}>
        <Navbar variant="home" />
        <Hero />
      </div>
      <main>
        <PartnerMarquee />
        <WhoWeHelp />
        <HowItWorks />
        <StatsCircles />
        <VettingProcess />
        <AIRecruiter />
        <WhyRemotiv />
        <Testimonials />
        <BrowseRoles />
        <StatsCards />
        <CtaInquiry />
      </main>
      <Footer />
    </>
  );
}
