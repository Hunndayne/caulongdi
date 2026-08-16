// Ting AI — agent tool-calling (DeepSeek, OpenAI-compatible function calling).
//
// Named imports used from "./bot" (exact list, keep in sync if this file's imports change):
//   types:     BotReply, BotActor, BotContextMessage, SessionDraft, CostDraft
//   functions: loadGroupMemberNames, vnNow, vnToday,
//              replyMembers, replyAttendees, replyAddMembers, replyRemoveMembers,
//              replyCreateSession, replyUpdateSession, replyCancelSession, replyStats,
//              replyCosts, replyAddCost, replyUpdateCost, replyMarkPaid, replyMyDebts,
//              replySessions
//
// Không dùng thêm bất kỳ symbol nào khác từ bot.ts (kể cả SELF_NAME_TOKEN, normalizeName,
// resolveSessionForAction...) — mọi thứ còn thiếu được cài lại cục bộ ở file này, hoặc lách qua
// bằng cách truyền tham số phù hợp cho các hàm reply* đã có.

import type { Env } from "../types";
import type {
  BotReply,
  BotActor,
  BotContextMessage,
  SessionDraft,
  CostDraft,
} from "./bot";
import {
  loadGroupMemberNames,
  vnNow,
  vnToday,
  replyMembers,
  replyAttendees,
  replyAddMembers,
  replyRemoveMembers,
  replyCreateSession,
  replyUpdateSession,
  replyCancelSession,
  replyStats,
  replyCosts,
  replyAddCost,
  replyUpdateCost,
  replyMarkPaid,
  replyMyDebts,
  replySessions,
} from "./bot";

export interface RunAgentArgs {
  groupId: string;
  groupName: string;
  text: string;
  actor?: BotActor;
  context?: BotContextMessage[];
  aliases?: Map<string, string>;
  groupSummary?: string;
}

// deepseek-chat/deepseek-reasoner (tên cũ) bị retire hẳn sau 24/7/2026 — dùng tên model V4 mới.
// (Trùng giá trị mặc định với bot.ts vì không được import const nội bộ đó.)
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const MAX_ROUNDS = 4;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_REPLY_CHARS = 1600;

// --- Kiểu dữ liệu cho vòng lặp tool-calling kiểu OpenAI ---

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: DeepSeekToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type DeepSeekChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
  }>;
};

type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

// --- Helpers rút gọn giá trị JSON không tin cậy từ model ---

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStrArr(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

function asNum(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function sessionRefFrom(value: unknown): SessionDraft | undefined {
  const raw = asObj(value);
  const draft: SessionDraft = { date: asStr(raw.date), startTime: asStr(raw.startTime), venue: asStr(raw.venue) };
  return draft.date || draft.startTime || draft.venue ? draft : undefined;
}

function sessionRefSummary(ref?: SessionDraft): string {
  if (!ref || (!ref.date && !ref.startTime && !ref.venue)) return "buổi sắp tới gần nhất";
  const parts: string[] = [];
  if (ref.date) parts.push(`ngày ${ref.date}`);
  if (ref.startTime) parts.push(`lúc ${ref.startTime}`);
  if (ref.venue) parts.push(`tại ${ref.venue}`);
  return `buổi ${parts.join(" ")}`;
}

// Chuẩn hoá tên tối thiểu (bỏ dấu + hạ chữ thường) để so khớp với alias map — cùng công thức
// bot.ts dùng cho sender_norm, cài lại cục bộ vì không import được hàm nội bộ đó.
function normalizeSimple(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Xác định tên chính xác (đúng như lưu trên web) của người gửi hiện tại, để nhét vào system
// prompt — thay thế cho SELF_NAME_TOKEN nội bộ của bot.ts (không export nên không dùng được).
async function resolveSelfName(env: Env, args: RunAgentArgs): Promise<string | undefined> {
  const actor = args.actor;
  if (actor?.memberId) {
    const row = await env.DB.prepare("SELECT name FROM members WHERE id = ? AND group_id = ?")
      .bind(actor.memberId, args.groupId)
      .first<{ name: string }>()
      .catch(() => null);
    if (row?.name) return row.name;
  }
  const rawName = actor?.name?.trim();
  if (rawName && args.aliases?.size) {
    const memberId = args.aliases.get(normalizeSimple(rawName));
    if (memberId) {
      const row = await env.DB.prepare("SELECT name FROM members WHERE id = ? AND group_id = ?")
        .bind(memberId, args.groupId)
        .first<{ name: string }>()
        .catch(() => null);
      if (row?.name) return row.name;
    }
  }
  return rawName || undefined;
}

// --- System prompt ---

function buildSystemPrompt(groupName: string, roster: string[], selfName: string | undefined, groupSummary?: string): string {
  const now = vnNow();
  const weekdayNames = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  const lines = [
    `Bạn là "Ting AI" — trợ lý AI trong group chat Messenger của nhóm cầu lông "${groupName}" trên TingTing.`,
    `Hôm nay là ${weekdayNames[now.getUTCDay()]}, ngày ${vnToday()} (giờ Việt Nam).`,
    "Bạn có các tool (function calling) để tra cứu và thao tác DỮ LIỆU THẬT của nhóm (lịch buổi, thành viên, chi phí, công nợ). LUÔN gọi tool để lấy dữ liệu hoặc thực hiện thao tác — TUYỆT ĐỐI không tự bịa lịch, tên người, số tiền, công nợ khi chưa gọi tool.",
    "Nếu người dùng yêu cầu nhiều việc trong một câu (ví dụ 'tạo kèo mai rồi thêm tôi vào, ghi tiền sân 200k'), hãy gọi tuần tự nhiều tool ở các lượt liên tiếp cho tới khi xong hết, không cần hỏi lại giữa chừng trừ khi thiếu thông tin bắt buộc (ví dụ tạo buổi mà chưa rõ ngày/giờ/sân).",
    "Sau khi có đủ kết quả từ tool, trả lời NGẮN GỌN và TỰ NHIÊN bằng tiếng Việt (khoảng 1-6 câu tuỳ độ phức tạp), như đang nhắn tin trong group chat — không lặp lại nguyên văn JSON hay log kỹ thuật, không nói những cụm máy móc kiểu \"tool trả về\".",
    "Ngữ cảnh gần đây BAO GỒM cả những câu chính bạn (assistant) vừa nói ở lượt trước. Nếu tin hiện tại của người dùng là câu TRẢ LỜI hoặc phản hồi cho điều bạn vừa hỏi/đề nghị (kể cả khi họ nói ngắn/mơ hồ như \"ừ\", \"có\", \"ok\", \"giúp mình đi\", \"làm đi\"), hãy hiểu và TIẾP NỐI đúng việc đó — ví dụ bạn vừa hỏi \"cần nhắc X trả nợ không?\" mà họ đáp \"ừ giúp mình\" thì tiến hành nhắc, đừng trả lời chung chung như chưa từng hỏi.",
    "KHÔNG dùng Markdown (không **in đậm**, không # tiêu đề, không `code`, không [text](link)) — Messenger hiển thị nguyên ký tự đó nên xấu; chỉ dùng chữ thuần, xuống dòng và emoji.",
    roster.length
      ? `DANH SÁCH THÀNH VIÊN của nhóm trên web: ${roster.join("; ")}. Khi điền tham số tên cho tool (names, memberNames, payerName, consumerNames, participantNames...), nếu nhận ra người dùng đang nói tới MỘT người trong danh sách trên thì PHẢI ghi lại ĐÚNG NGUYÊN VĂN tên trong danh sách — kể cả khi họ gõ thiếu dấu, sai thứ tự họ tên, hay gọi tên tắt. Nếu không chắc hoặc khớp nhiều người, giữ nguyên văn người dùng gõ; TUYỆT ĐỐI không bịa tên không có trong danh sách.`
      : "Nhóm hiện chưa có thành viên nào trong danh sách trên web.",
    selfName
      ? `Người gửi tin nhắn hiện tại tên là "${selfName}" trên web. Khi họ nói tôi/mình/tui/em/anh/chị để chỉ chính họ, hãy dùng đúng chuỗi "${selfName}" cho các tham số tên liên quan (names, memberNames, payerName, consumerNames, participantNames).`
      : "Chưa xác định được người gửi ứng với thành viên nào trên web — nếu bắt buộc cần biết chính xác họ là ai (ví dụ ghi công nợ), hỏi lại hoặc gợi ý họ dùng lệnh /alias <tên trên web>.",
    'QUY TẮC XÁC NHẬN CHO THAO TÁC NGUY HIỂM: hai tool "cancel_session" (hủy buổi) và "update_cost" khi xoá khoản chi (deleteCost=true) không thể hoàn tác. Lần đầu người dùng yêu cầu, gọi tool đó với confirmed=false (hoặc bỏ trống) để lấy thông tin buổi/khoản chi, rồi TỰ VIẾT một câu hỏi ngắn gọn xác nhận lại với người dùng — KHÔNG tự ý thực hiện luôn. CHỈ khi người dùng đã đồng ý rõ ràng ở tin nhắn sau đó (xem lại các lượt hội thoại trước) mới gọi LẠI đúng tool đó với confirmed=true để thực sự hủy/xóa. Các thao tác ghi khác (thêm/rút người, ghi chi phí, tạo/sửa buổi, sửa khoản chi không xoá) thực hiện luôn, không cần hỏi xác nhận trước.',
    groupSummary
      ? `Tóm tắt phong cách/ngữ cảnh chat của nhóm: ${groupSummary}. Có thể bắt chước tông giọng này (mức đùa giỡn, thân mật, teencode, emoji...) khi hợp lý.`
      : "",
  ].filter(Boolean);
  return lines.join(" ");
}

function buildContextMessages(context?: BotContextMessage[]): ChatMessage[] {
  const items = (context ?? []).slice(-MAX_CONTEXT_MESSAGES);
  return items.map((item): ChatMessage => {
    const text = item.text.replace(/^\/ting\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (item.role === "assistant") return { role: "assistant", content: text };
    const who = item.userName?.trim();
    return { role: "user", content: who ? `${who}: ${text}` : text };
  });
}

function buildUserMessage(args: RunAgentArgs): string {
  const sender = args.actor?.name?.trim() || args.actor?.userId || "không rõ";
  return `Người gửi: ${sender}\nTin nhắn hiện tại: ${args.text}`;
}

// --- Khai báo tool cho DeepSeek (OpenAI function-calling schema) ---

const SESSION_REF_SCHEMA = {
  type: "object",
  description:
    "Buổi cầu lông đang nói tới. Bỏ trống toàn bộ (không truyền field nào) nếu người dùng không chỉ rõ buổi nào — hệ thống sẽ tự chọn buổi gần nhất phù hợp.",
  properties: {
    date: { type: "string", description: 'Ngày của buổi, định dạng YYYY-MM-DD, ví dụ "2026-08-20".' },
    startTime: { type: "string", description: 'Giờ bắt đầu của buổi, định dạng HH:MM 24 giờ, ví dụ "17:00".' },
    venue: { type: "string", description: "Tên sân/địa điểm của buổi." },
  },
} as const;

function buildTools(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "find_sessions",
        description:
          "Tra danh sách buổi chơi cầu lông theo mốc thời gian (kèo sắp tới, hôm nay, tuần này, gần đây...), hoặc theo một ngày/sân cụ thể nếu người dùng nêu rõ.",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["next", "upcoming", "today", "week", "recent"],
              description:
                "next=buổi kế tiếp gần nhất; upcoming=các buổi sắp tới; today=hôm nay; week=tuần này; recent=các buổi gần đây/lịch sử.",
            },
            date: { type: "string", description: 'Chỉ điền khi người dùng hỏi về một ngày cụ thể, định dạng YYYY-MM-DD.' },
            venue: { type: "string", description: "Chỉ điền khi người dùng hỏi về một sân/địa điểm cụ thể." },
          },
          required: ["scope"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_session_attendees",
        description: "Xem ai (thành viên nào) đang tham gia một buổi chơi cụ thể.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Ngày của buổi, định dạng YYYY-MM-DD." },
            startTime: { type: "string", description: "Giờ bắt đầu của buổi, định dạng HH:MM." },
            venue: { type: "string", description: "Tên sân/địa điểm của buổi." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_members",
        description: "Liệt kê toàn bộ thành viên đang có trong nhóm (không gắn với buổi cụ thể nào).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_costs",
        description: "Xem chi phí/công nợ (ai nợ ai, đã trả/chưa trả) của MỘT buổi cụ thể.",
        parameters: {
          type: "object",
          properties: { sessionRef: SESSION_REF_SCHEMA },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_member_debts",
        description:
          "Xem công nợ CÒN LẠI của một hoặc nhiều người, TÍNH TRÊN MỌI BUỔI (khác get_costs là công nợ trong một buổi). Không nêu tên ai thì mặc định hỏi về chính người gửi.",
        parameters: {
          type: "object",
          properties: {
            memberNames: {
              type: "array",
              items: { type: "string" },
              description: "Tên (đúng nguyên văn danh sách thành viên) của người cần tra công nợ. Để mảng rỗng [] nếu hỏi về chính người gửi.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_stats",
        description: "Xem thống kê tổng hợp nhiều buổi: số buổi đã chơi, ai tham gia nhiều nhất, tổng chi tiêu theo tuần/tháng/năm.",
        parameters: {
          type: "object",
          properties: {
            period: {
              type: "string",
              description:
                'Khoảng thời gian muốn thống kê, viết tự nhiên bằng tiếng Việt, ví dụ "tuần này", "tháng này", "tháng trước", "năm nay". Bỏ trống thì mặc định tháng này.',
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_members",
        description: "Thêm một hoặc nhiều người vào một buổi chơi (đăng ký tham gia).",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "Danh sách tên (đúng nguyên văn danh sách thành viên) cần thêm vào buổi.",
            },
            sessionRef: SESSION_REF_SCHEMA,
          },
          required: ["names"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_members",
        description: "Rút một hoặc nhiều người ra khỏi một buổi chơi (huỷ tham gia).",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "Danh sách tên (đúng nguyên văn danh sách thành viên) cần rút khỏi buổi.",
            },
            sessionRef: SESSION_REF_SCHEMA,
          },
          required: ["names"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_session",
        description: "Tạo một buổi/kèo chơi cầu lông mới.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Ngày buổi, định dạng YYYY-MM-DD (quy đổi 'ngày mai', 'thứ 7'... theo hôm nay)." },
            startTime: { type: "string", description: "Giờ bắt đầu, định dạng HH:MM 24 giờ." },
            endTime: { type: "string", description: "Giờ kết thúc (nếu người dùng nêu), định dạng HH:MM 24 giờ." },
            venue: { type: "string", description: "Tên sân/địa điểm." },
            participantNames: {
              type: "array",
              items: { type: "string" },
              description: "Những người được nhắc sẽ tham gia ngay khi tạo buổi (đúng nguyên văn danh sách thành viên).",
            },
          },
          required: ["date", "startTime", "venue"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_session",
        description: "Sửa thông tin (ngày/giờ bắt đầu/giờ kết thúc/sân) của một buổi ĐÃ CÓ.",
        parameters: {
          type: "object",
          properties: {
            sessionRef: SESSION_REF_SCHEMA,
            changes: {
              type: "object",
              description: "Giá trị MỚI muốn đổi sang — chỉ điền field thực sự cần đổi.",
              properties: {
                date: { type: "string", description: "Ngày mới, định dạng YYYY-MM-DD." },
                startTime: { type: "string", description: "Giờ bắt đầu mới, định dạng HH:MM." },
                endTime: { type: "string", description: "Giờ kết thúc mới, định dạng HH:MM." },
                venue: { type: "string", description: "Sân/địa điểm mới." },
              },
            },
          },
          required: ["changes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_session",
        description:
          "NGUY HIỂM — hủy/xoá hẳn một buổi chơi (kèm toàn bộ chi phí/công nợ của buổi đó). Không thể hoàn tác. Bắt buộc phải hỏi xác nhận người dùng trước khi thực sự thực hiện (xem QUY TẮC XÁC NHẬN).",
        parameters: {
          type: "object",
          properties: {
            sessionRef: SESSION_REF_SCHEMA,
            confirmed: {
              type: "boolean",
              description: "true CHỈ khi người dùng đã xác nhận rõ ràng ở lượt trước muốn hủy buổi này. Mặc định false.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_cost",
        description: "Ghi một khoản chi phí VỪA phát sinh vào một buổi (tiền sân, tiền cầu, tiền nước...).",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: 'Tên khoản chi, ví dụ "tiền sân", "ống cầu", "tiền ăn".' },
            amount: { type: "number", description: "Số tiền VND TUYỆT ĐỐI (không viết tắt), ví dụ 240k → 240000." },
            quantity: { type: "integer", description: "Số lượng, mặc định 1." },
            payerName: {
              type: "string",
              description: 'Người ỨNG/TRẢ khoản này (đúng nguyên văn danh sách thành viên). Bỏ trống nếu chính người gửi trả.',
            },
            consumerNames: {
              type: "array",
              items: { type: "string" },
              description: "Danh sách người ĐƯỢC CHIA khoản này. Để trống nếu chia đều cả buổi.",
            },
            sessionRef: SESSION_REF_SCHEMA,
          },
          required: ["label", "amount"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_cost",
        description:
          "Sửa (đổi người trả/số tiền/người chia) hoặc XOÁ (deleteCost=true) một khoản chi ĐÃ ghi trước đó trong một buổi. Xoá khoản chi là thao tác NGUY HIỂM, không thể hoàn tác — bắt buộc hỏi xác nhận trước (xem QUY TẮC XÁC NHẬN).",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "Tên khoản chi CẦN SỬA/XOÁ (khớp gần đúng với tên đã ghi)." },
            amount: { type: "number", description: "Số tiền VND tuyệt đối MỚI, nếu muốn đổi số tiền." },
            payerName: { type: "string", description: "Người trả MỚI, nếu muốn đổi người trả (đúng nguyên văn danh sách thành viên)." },
            consumerNames: {
              type: "array",
              items: { type: "string" },
              description: "Danh sách người chia MỚI, nếu muốn đổi phạm vi chia.",
            },
            deleteCost: { type: "boolean", description: "true nếu người dùng muốn XOÁ hẳn khoản chi này (không sửa)." },
            confirmed: {
              type: "boolean",
              description: "Chỉ áp dụng khi deleteCost=true: true CHỈ khi người dùng đã xác nhận rõ ràng ở lượt trước muốn xoá khoản này. Mặc định false.",
            },
            sessionRef: SESSION_REF_SCHEMA,
          },
          required: ["label"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mark_paid",
        description: 'Người dùng báo đã trả/đã chuyển khoản công nợ của một buổi ("tôi trả Nam rồi", "đã chuyển khoản").',
        parameters: {
          type: "object",
          properties: { sessionRef: SESSION_REF_SCHEMA },
        },
      },
    },
  ];
}

// --- Thực thi tool: map tên tool -> hàm reply* đã có sẵn trong bot.ts ---

async function executeTool(
  env: Env,
  args: RunAgentArgs,
  name: string,
  rawArgs: unknown,
  aliases: Map<string, string> | undefined
): Promise<string> {
  const a = asObj(rawArgs);
  const { groupId, groupName, text, actor, context } = args;

  switch (name) {
    case "find_sessions": {
      const scopes = ["next", "upcoming", "today", "week", "recent"] as const;
      const requested = asStr(a.scope);
      const scope = (scopes as readonly string[]).includes(requested ?? "") ? (requested as (typeof scopes)[number]) : "upcoming";
      const selector: SessionDraft = { date: asStr(a.date), venue: asStr(a.venue) };
      const result = await replySessions(env, groupId, groupName, scope, selector);
      return result.reply;
    }

    case "get_session_attendees": {
      const selector: SessionDraft = { date: asStr(a.date), startTime: asStr(a.startTime), venue: asStr(a.venue) };
      const result = await replyAttendees(env, groupId, groupName, selector, text, context);
      return result.reply;
    }

    case "list_members": {
      const result = await replyMembers(env, groupId, groupName);
      return result.reply;
    }

    case "get_costs": {
      const selector = sessionRefFrom(a.sessionRef);
      const result = await replyCosts(env, groupId, groupName, text, selector, context);
      return result.reply;
    }

    case "get_member_debts": {
      const names = asStrArr(a.memberNames);
      const result = await replyMyDebts(env, groupId, groupName, actor, names, aliases);
      return result.reply;
    }

    case "get_stats": {
      const period = asStr(a.period);
      const result = await replyStats(env, groupId, groupName, period ?? text);
      return result.reply;
    }

    case "add_members": {
      const names = asStrArr(a.names);
      const selector = sessionRefFrom(a.sessionRef);
      const result = await replyAddMembers(env, groupId, groupName, names, actor, selector, aliases, text, context);
      return result.reply;
    }

    case "remove_members": {
      const names = asStrArr(a.names);
      const selector = sessionRefFrom(a.sessionRef);
      const result = await replyRemoveMembers(env, groupId, groupName, names, actor, selector, aliases, text, context);
      return result.reply;
    }

    case "create_session": {
      const draft: SessionDraft = {
        date: asStr(a.date),
        startTime: asStr(a.startTime),
        endTime: asStr(a.endTime),
        venue: asStr(a.venue),
      };
      const names = asStrArr(a.participantNames);
      const result = await replyCreateSession(env, groupId, groupName, draft, actor, names, aliases);
      return result.reply;
    }

    case "update_session": {
      const selector = sessionRefFrom(a.sessionRef);
      const rawChanges = asObj(a.changes);
      const changes: SessionDraft = {
        date: asStr(rawChanges.date),
        startTime: asStr(rawChanges.startTime),
        endTime: asStr(rawChanges.endTime),
        venue: asStr(rawChanges.venue),
      };
      const result = await replyUpdateSession(env, groupId, groupName, selector, changes);
      return result.reply;
    }

    case "cancel_session": {
      const selector = sessionRefFrom(a.sessionRef);
      const confirmed = asBool(a.confirmed);
      if (!confirmed) {
        return `NEEDS_CONFIRMATION: Xác nhận HỦY ${sessionRefSummary(selector)}? Thao tác này sẽ xoá buổi cùng toàn bộ chi phí/công nợ liên quan, không thể hoàn tác.`;
      }
      // replyCancelSession tự nhận biết xác nhận qua text+context (isCancelConfirmation nội bộ
      // của bot.ts) — ta đã tự gác cổng ở đây rồi (confirmed=true từ model), nên truyền một
      // cặp text/context "đồng ý hủy" chuẩn để chắc chắn nó thực sự thực thi, bất kể người dùng
      // gõ nguyên văn thế nào ở lượt xác nhận.
      const confirmContext: BotContextMessage[] = [
        ...(context ?? []),
        { role: "assistant", text: "Xác nhận hủy buổi này? Trả lời đồng ý hủy để xác nhận." },
      ];
      const result = await replyCancelSession(env, groupId, groupName, "đồng ý hủy", selector, confirmContext);
      return result.reply;
    }

    case "add_cost": {
      const cost: CostDraft = {
        label: asStr(a.label),
        amount: asNum(a.amount),
        quantity: asNum(a.quantity),
        payerName: asStr(a.payerName),
        consumerNames: asStrArr(a.consumerNames).length ? asStrArr(a.consumerNames) : undefined,
      };
      const selector = sessionRefFrom(a.sessionRef);
      const result = await replyAddCost(env, groupId, groupName, text, actor, cost, selector, aliases);
      return result.reply;
    }

    case "update_cost": {
      const cost: CostDraft = {
        label: asStr(a.label),
        amount: asNum(a.amount),
        payerName: asStr(a.payerName),
        consumerNames: asStrArr(a.consumerNames).length ? asStrArr(a.consumerNames) : undefined,
      };
      const selector = sessionRefFrom(a.sessionRef);
      const deleteCost = asBool(a.deleteCost);

      if (deleteCost) {
        const confirmed = asBool(a.confirmed);
        if (!confirmed) {
          return `NEEDS_CONFIRMATION: Xác nhận XOÁ khoản "${cost.label ?? "chưa rõ"}" khỏi ${sessionRefSummary(selector)}? Không thể hoàn tác.`;
        }
        // replyUpdateCost tự nhận diện "xoá" qua từ khoá trong text (isDeleteCostLike nội bộ) —
        // ta đã gác cổng xác nhận ở trên rồi, nên ghép thêm cụm chắc khớp regex đó vào text gốc,
        // giữ nguyên phần còn lại để không mất ngữ cảnh chọn buổi.
        const deleteText = `${text} xoá khoản ${cost.label ?? ""}`.trim();
        const result = await replyUpdateCost(env, groupId, groupName, deleteText, actor, cost, selector, aliases, context);
        return result.reply;
      }

      const result = await replyUpdateCost(env, groupId, groupName, text, actor, cost, selector, aliases, context);
      return result.reply;
    }

    case "mark_paid": {
      const selector = sessionRefFrom(a.sessionRef);
      const result = await replyMarkPaid(env, groupId, groupName, text, selector);
      return result.reply;
    }

    default:
      return `LỖI: không có tool tên "${name}".`;
  }
}

async function safeExecuteTool(
  env: Env,
  args: RunAgentArgs,
  call: DeepSeekToolCall,
  aliases: Map<string, string> | undefined
): Promise<string> {
  const name = call.function?.name ?? "";
  let parsed: unknown = {};
  try {
    parsed = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    parsed = {};
  }
  try {
    return await executeTool(env, args, name, parsed, aliases);
  } catch (err) {
    console.error("[bot-agent] tool", name, err);
    return "LỖI: thao tác này gặp sự cố kỹ thuật, thử lại sau hoặc thao tác trên web TingTing.";
  }
}

// --- Vòng lặp chính ---

export async function runAgent(env: Env, args: RunAgentArgs): Promise<BotReply | null> {
  try {
    const apiKey = env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) return null;
    const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
    const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;

    const [roster, selfName] = await Promise.all([
      loadGroupMemberNames(env, args.groupId).catch(() => []),
      resolveSelfName(env, args).catch(() => undefined),
    ]);

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(args.groupName, roster, selfName, args.groupSummary) },
      ...buildContextMessages(args.context),
      { role: "user", content: buildUserMessage(args) },
    ];

    const tools = buildTools();
    let lastToolContent: string | null = null;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
        }),
      });

      if (!resp.ok) {
        console.error("[bot-agent] deepseek http", resp.status, await resp.text().catch(() => ""));
        return null;
      }

      const data = (await resp.json()) as DeepSeekChatResponse;
      const message = data?.choices?.[0]?.message;
      if (!message) {
        console.error("[bot-agent] deepseek empty message");
        return null;
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const content = message.content?.trim();
        if (content) return { ok: true, reply: content.slice(0, MAX_REPLY_CHARS) };
        break; // model không gọi tool cũng không trả lời — hết cách, rơi về flow cũ.
      }

      // Lưu lượt gọi tool của assistant để model còn nhớ ở vòng sau.
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });

      for (const call of toolCalls) {
        const content = await safeExecuteTool(env, args, call, args.aliases);
        lastToolContent = content;
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    // Hết vòng lặp mà model không chốt câu trả lời cuối — tổng hợp tạm từ kết quả tool gần nhất
    // thay vì bỏ trắng, vẫn ưu tiên fallback về flow cũ nếu không có gì để tổng hợp.
    if (lastToolContent) {
      const cleaned = lastToolContent.replace(/^NEEDS_CONFIRMATION:\s*/, "").trim();
      if (cleaned) return { ok: true, reply: cleaned.slice(0, MAX_REPLY_CHARS) };
    }
    return null;
  } catch (err) {
    console.error("[bot-agent]", err);
    return null;
  }
}
