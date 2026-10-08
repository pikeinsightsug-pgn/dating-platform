// Private-backend adapter template.
// Deploy this server-side, NOT as a public GitHub Pages script.
// Put the real API URL and credentials in server environment variables.

export async function getMetrics() {
  const response = await fetch(process.env.REGISTRATION_API_URL + "/metrics", {
    headers: { Authorization: "Bearer " + process.env.REGISTRATION_API_KEY }
  });
  if (!response.ok) throw new Error("Registration metrics unavailable");
  return response.json();
}

export async function getAuthorizedMembers() {
  const response = await fetch(process.env.REGISTRATION_API_URL + "/members/authorized", {
    headers: { Authorization: "Bearer " + process.env.REGISTRATION_API_KEY }
  });
  if (!response.ok) throw new Error("Member data unavailable");
  return response.json();
}
