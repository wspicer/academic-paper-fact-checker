import sys
from pathlib import Path

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from checker import check_claim, get_secret

DAILY_LIMIT = int(get_secret("CHECKS_PER_SESSION") or 10)
VERDICT_STYLE = {
    "supported": ("✅", "green"),
    "contradicted": ("❌", "red"),
    "mixed": ("⚖️", "orange"),
    "insufficient evidence": ("❔", "gray"),
}

st.set_page_config(page_title="Science Fact Checker", page_icon="🔬")
st.title("🔬 Science Fact Checker")
st.caption("Checks a claim against published research abstracts from OpenAlex and "
           "Semantic Scholar. An AI summary of evidence, not a final ruling. "
           "Always read the papers.")

# --- API key: owner's key with a per-session limit, or the user's own key ---
with st.sidebar:
    st.header("Settings")
    user_key = st.text_input("Your Anthropic API key (optional)", type="password",
                             help="Use your own key for unlimited checks. It is not stored.")
    owner_key = get_secret("ANTHROPIC_API_KEY")
    used = st.session_state.setdefault("checks_used", 0)
    if not user_key and owner_key:
        st.write(f"Free checks left this session: **{max(0, DAILY_LIMIT - used)}**")

api_key = user_key or owner_key

claim = st.text_area("Enter a claim to check",
                     placeholder="e.g. Drinking coffee lowers the risk of type 2 diabetes",
                     max_chars=500)


@st.cache_data(ttl=60 * 60 * 24, show_spinner=False)
def cached_check(claim_text: str, key: str) -> dict:
    return check_claim(claim_text, key)


if st.button("Check claim", type="primary", disabled=not claim.strip()):
    if not api_key:
        st.error("No API key configured. Add one in the sidebar.")
        st.stop()
    if not user_key and used >= DAILY_LIMIT:
        st.warning("You've used your free checks. Add your own API key in the sidebar.")
        st.stop()

    with st.spinner("Searching papers and weighing the evidence..."):
        try:
            data = cached_check(claim.strip(), api_key)
        except Exception as e:
            st.error(f"Something went wrong: {e}")
            st.stop()
    if not user_key:
        st.session_state.checks_used += 1

    r = data["result"]
    icon, color = VERDICT_STYLE.get(r.get("verdict", ""), ("❔", "gray"))
    st.subheader(f"{icon} :{color}[{r.get('verdict', 'unknown').title()}]")
    st.write(f"**Confidence:** {r.get('confidence', '?')}")
    st.write(r.get("summary", ""))

    if r.get("caveats"):
        st.markdown("**Caveats**")
        for c in r["caveats"]:
            st.markdown(f"- {c}")

    stance = {p["n"]: p for p in r.get("papers", [])}
    st.markdown("### Evidence")
    for i, p in enumerate(data["papers"], 1):
        s = stance.get(i, {})
        label = s.get("stance", "neutral")
        if label == "irrelevant":
            continue
        with st.expander(f"[{i}] {label.upper()}: {p['title']} ({p['year']})"):
            st.write(s.get("note", ""))
            st.caption(f"{p['venue'] or 'Unknown venue'} · {p['citations']} citations · "
                       f"via {p['source']}")
            st.write(p["abstract"][:1200] + ("…" if len(p["abstract"]) > 1200 else ""))
            if p["url"]:
                st.markdown(f"[Open paper]({p['url']})")

    if data["retracted"]:
        st.warning("Excluded retracted papers: " +
                   "; ".join(p["title"] for p in data["retracted"]))
    with st.expander("How this was searched"):
        st.write("Queries:", data["queries"])
        if data["errors"]:
            st.write("Search errors:", data["errors"])
