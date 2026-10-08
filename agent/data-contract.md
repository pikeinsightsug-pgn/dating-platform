# Private Registration Data Contract

The public GitHub Pages site must never fetch raw Google Form responses directly.

A private backend/authorized connector should expose only the minimum fields needed by the agent.

## Recommended endpoints

GET /metrics
Returns:
{
  "total_members": 0,
  "new_today": 0,
  "uganda": 0,
  "botswana": 0,
  "incomplete": 0
}

GET /members/authorized
Returns only approved, non-sensitive matching fields.

GET /members/{id}/matching-summary
Returns a privacy-minimized summary for an authorized matching workflow.

## Security requirements

- Authenticate every request.
- Keep API keys/server credentials outside GitHub.
- Do not expose raw spreadsheet URLs publicly.
- Use HTTPS.
- Restrict access to the owner/authorized agent.
- Log administrative actions.
- Allow member deletion/correction workflows.
- Never expose contact fields to the public website.
- Validate that every member is 18+ before matchmaking.
