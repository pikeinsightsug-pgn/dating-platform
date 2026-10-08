# Airtable Deployment Plan

Use Airtable as the private operational database for the Dating Platform Manager.

## Base
Create a base named:
**Dating Platform Manager**

## Tables

### Members
Fields:
- Member ID (primary)
- Status (Registered / Incomplete / Approved / Suspended / Deleted)
- Country
- Age
- Gender (optional; member-provided)
- Relationship Goal
- Preferred Age Min
- Preferred Age Max
- Preferred Country
- Interests
- Profile Text
- Created At
- Contact Phone (private)
- WhatsApp (private)
- Email (private)

### Platform Metrics
Fields:
- Date
- Total Members
- New Today
- Uganda
- Botswana
- Incomplete

### Support Queue
Fields:
- Ticket ID
- Member ID
- Topic
- Draft Reply
- Status
- Created At
- Owner Approval

### Match Suggestions
Fields:
- Suggestion ID
- Member A ID
- Member B ID
- Compatibility Score
- Reason
- Status
- Created At
- Owner Approval

## Privacy
Contact Phone, WhatsApp and Email should never be exposed to the public website or included in normal matching output.

## First 100 launch
Use a view/filter for:
Status = Approved
Age >= 18
Country = Uganda OR Botswana

The agent should count approved members from this view and report progress toward 100.

## Important
Do not paste API keys or private member data into GitHub.
