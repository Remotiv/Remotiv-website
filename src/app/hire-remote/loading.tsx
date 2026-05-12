export default function Loading() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-6 py-20">
      <div className="animate-pulse flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-remotiv-purple/20" />
        <div className="h-4 w-48 rounded bg-[#666]/20" />
        <div className="h-3 w-32 rounded bg-[#666]/10" />
      </div>
    </div>
  );
}
