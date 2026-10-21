export type ParticipantStatus = "not_found" | "unique" | "duplicate";

export interface ParticipantResult {
  status: ParticipantStatus;
  /** Matching sheet rows. Empty when `status` is "not_found". */
  rows: string[][];
}

export interface VerifyMeta {
  staffName: string;
  discordId: string;
  threadLink: string;
}

export type VerifyStatus =
  | "ok"
  | "not_found"
  | "duplicate"
  | "already_verified"
  | "missing_columns";

export interface VerifyResult {
  status: VerifyStatus;
  row?: string[];
}

/** A team to append to a direct-registration event's sheet. */
export interface AppendData {
  teamName?: string;
  email: string;
  phone?: string;
  discordId: string;
  /** Link back to the verification ticket. */
  threadLink?: string;
}

export type AppendStatus = "ok" | "missing_columns";

export interface AppendResult {
  status: AppendStatus;
}
