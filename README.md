# Text

Edit guest RAM files or private server documents. A desktop document context
carries a storage kind, path and owner, never authoritative document contents.
The destination validates it and fetches through the current authorized client.

Save uses the loaded server content hash as its precondition. A conflicting
save keeps the local draft. Successful saves notify Files listings. Save As
creates a new file without overwriting another destination. Closing releases
view resources; it does not cancel a write already accepted by the server.

Server-generated word-count reports are ordinary private text documents and
can be reopened after signing in or reloading the site. Guest files remain
RAM-only until explicitly downloaded or saved to the server.

The source candidate supports browser documents opened from Files → This browser.
Their Save writes through the shared host IndexedDB client with the exact loaded
version; conflicts and cleared data preserve the local draft. Save As creates a
new destination, and reopening the original does not redirect to the copy.
Temporary guest documents offer Save browser copy… for explicit persistence;
ordinary guest Save remains RAM-only and is not silently uploaded or promoted.
This browser volume is not a backup against clearing site data, eviction or device
loss. See active-system/evidence/browser-files.md; not deployed.
