"""
AI creative-angle generator: feeds the competitor ad copy we already
scraped into an LLM and asks for new angles/hooks that aren't already
saturated in the results. Needs OPENAI_API_KEY set (in .env or the real
environment) - tested live and confirmed working.
"""

import os
from openai import OpenAI

_client = None

PROMPT_TEMPLATE = """You are a direct-response ad copywriter for dropshipping brands.
Below is real ad copy currently running from competitors for the product/niche "{keyword}".
Study the angles, pains, and hooks they lean on, then propose {n} NEW creative angles
to test that are genuinely different from what's already saturated below - not paraphrases
of the same angle.

For each angle give:
1. Angle name (3-5 words)
2. The pain/desire it targets
3. A ready-to-use scroll-stopping hook line (1 sentence)

Competitor ad copy:
{ads_text}
"""


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set - add it to .env")
        _client = OpenAI(api_key=api_key)
    return _client


def generate_angles(keyword, ad_bodies, n=8):
    ads_text = "\n---\n".join(b for b in ad_bodies if b)[:6000]
    prompt = PROMPT_TEMPLATE.format(keyword=keyword, n=n, ads_text=ads_text)
    resp = _get_client().chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0.9,
    )
    return resp.choices[0].message.content
