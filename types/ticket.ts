/** What a participant typed into the verification modal. */
export interface TicketSubmission {
  /** Team name or full name. Also used as the ticket thread's name. */
  name: string;
  email: string;
  phone?: string;
  /** Chess.com rating, only asked for in the Chess event. */
  chessRating?: string;
}
