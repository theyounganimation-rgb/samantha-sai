"""Read-only, account-scoped Apple Mail thread ownership. Candidate, not installed."""
import sqlite3
import urllib.parse


def first_sender_is_owner(connection, message_rowid, account_id, owner_email):
    """Return True/False if the earliest message is attributable, otherwise None.

    Only exact nonzero Apple Mail conversation IDs inside the selected account
    are considered. Unknown metadata remains unknown and must fail open.
    """
    if not isinstance(message_rowid, int) or message_rowid <= 0 or not account_id or not owner_email:
        return None
    incoming = connection.execute('''SELECT m.conversation_id, mb.url FROM messages m
        JOIN mailboxes mb ON mb.ROWID=m.mailbox WHERE m.ROWID=? AND m.deleted=0''', (message_rowid,)).fetchone()
    if not incoming or not incoming[0] or urllib.parse.urlsplit(incoming[1]).netloc.casefold() != account_id.casefold():
        return None
    if '/inbox' not in urllib.parse.urlsplit(incoming[1]).path.casefold():
        return None
    rows = connection.execute('''SELECT a.address, mb.url, COALESCE(NULLIF(m.date_sent,0),m.date_received) AS t
        FROM messages m JOIN mailboxes mb ON mb.ROWID=m.mailbox
        LEFT JOIN addresses a ON a.ROWID=m.sender
        WHERE m.conversation_id=? AND m.deleted=0 AND (mb.url LIKE ? OR mb.url LIKE ?)
        ORDER BY t ASC,m.ROWID ASC LIMIT 1''', (incoming[0], 'imap://'+account_id+'/%', 'ews://'+account_id+'/%')).fetchall()
    if not rows or not rows[0][0] or not rows[0][2]:
        return None
    return rows[0][0].strip().casefold() == owner_email.strip().casefold()
