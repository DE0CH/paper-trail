import { controller, type Snapshot } from '../core/controller';
import { MOD } from '../core/platform';
import { IconClose } from './icons';

export default function Welcome({ snap }: { snap: Snapshot }) {
  if (snap.docOpen) return null;

  if (snap.pendingPdfName) {
    // A reading session was opened first; ask for its PDF.
    return (
      <div id="welcome" className="absolute inset-0 flex items-center justify-center">
        <div id="sessionPrompt" className="text-center text-dim max-w-115">
          <h1 className="text-fgapp font-semibold text-[20px]">Reading session loaded</h1>
          <p className="mt-3">
            This session belongs to <span className="text-fgapp">{snap.pendingPdfName}</span>.<br />
            Open that PDF to pick up where you left off.
          </p>
          <button
            id="btnPendingOpen"
            className="mt-4 bg-accent text-white text-sm px-4.5 py-2 rounded-lg cursor-pointer hover:brightness-110"
            onClick={() => void controller.pickFile()}
          >
            Choose the PDF&hellip;
          </button>
          <p className="text-xs mt-2">or drop it anywhere</p>
          <button
            className="mt-4 text-dim hover:text-fgapp text-xs underline cursor-pointer"
            onClick={() => controller.discardPendingSession()}
          >
            discard this session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div id="welcome" className="absolute inset-0 flex items-center justify-center">
      <div className="text-center text-dim max-w-115">
        <h1 className="text-fgapp font-semibold text-[22px]">Paper Trail</h1>
        <p className="mt-3 leading-relaxed text-pretty">
          A PDF reader that remembers <em>how</em> you got where you are.
          Every reference you follow extends your reading trail, so you can
          dive many levels deep and pop back to the exact spot you left.
          {' '}{MOD}-click a link to follow it in a new trail.
        </p>
        <button
          className="mt-4 bg-accent text-white text-sm px-4.5 py-2 rounded-lg cursor-pointer hover:brightness-110"
          onClick={() => void controller.pickFile()}
        >
          Choose a PDF&hellip;
        </button>
        <p className="text-xs mt-2">or drop a file anywhere</p>

        {snap.recents.length > 0 && (
          <div id="recent" className="mt-5 text-left">
            {/* px-2.5: the heading starts on the same x as the rows' text.
                11px: the uppercase tracked section-label role has ONE size
                app-wide (the shortcut-help group titles set it). */}
            <h3 className="text-dim text-[11px] uppercase tracking-wider mb-1 px-2.5">Recent</h3>
            {snap.recents.map((d) => (
              <div
                key={`${d.entry.timestamp}|${d.entry.pdfName}|${d.entry.sessionFileName}`}
                className="recentItem group flex items-center px-2.5 py-1.5 rounded-md cursor-pointer text-fgapp hover:bg-hoverrow"
                onClick={() => void controller.openRecent(d.entry)}
              >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {d.text}
                  <span className="text-dim text-[11px] ml-2">
                    {new Date(d.entry.timestamp).toLocaleDateString()}
                  </span>
                </span>
                <button
                  className="removeRecent flex-none inline-flex items-center justify-center w-5 h-5 ml-1 rounded text-dim opacity-0 group-hover:opacity-100 hover:bg-[#45474e] hover:text-fgapp cursor-pointer"
                  title="Remove from this list"
                  onClick={(e) => {
                    e.stopPropagation();
                    void controller.removeRecent(d.entry);
                  }}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
