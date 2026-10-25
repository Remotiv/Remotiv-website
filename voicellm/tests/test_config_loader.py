import os
import tempfile
import unittest

import yaml

from voxagent.config_loader import (
    PERSONA_DEFAULTS,
    build_persona_from_doc,
    load_model_config,
    load_persona_config,
    load_tts_config,
)


class TestLoadPersonaConfig(unittest.TestCase):
    def test_merges_with_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "persona.yaml")
            with open(path, "w") as f:
                yaml.safe_dump({"name": "Custom", "tts": {"voice": "am_michael"}}, f)

            merged = load_persona_config(path)

        self.assertEqual(merged["name"], "Custom")
        self.assertEqual(merged["tts"]["voice"], "am_michael")
        self.assertEqual(merged["tts"]["lang"], PERSONA_DEFAULTS["tts"]["lang"])
        self.assertEqual(merged["system_prompt"], PERSONA_DEFAULTS["system_prompt"])

    def test_resolves_relative_knowledge_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "persona.yaml")
            with open(path, "w") as f:
                yaml.safe_dump({"knowledge": [{"path": "doc.txt"}]}, f)

            merged = load_persona_config(path)

        self.assertEqual(merged["knowledge"][0]["path"], os.path.join(tmp, "doc.txt"))


class TestBuildPersonaFromDoc(unittest.TestCase):
    def test_uses_filename_as_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "fifa.txt")
            with open(path, "w") as f:
                f.write("some knowledge")

            persona = build_persona_from_doc(path)

        self.assertEqual(persona["name"], "fifa")
        self.assertEqual(persona["knowledge"][0]["strategy"], "prefix_cache")
        self.assertEqual(persona["knowledge"][0]["path"], os.path.abspath(path))


class TestLoadModelAndTtsConfig(unittest.TestCase):
    def test_load_model_config_requires_backend_and_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "model.yaml")
            with open(path, "w") as f:
                yaml.safe_dump({"model": {"path": "x.gguf"}}, f)

            with self.assertRaises(AssertionError):
                load_model_config(path)

    def test_load_tts_config_requires_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tts.yaml")
            with open(path, "w") as f:
                yaml.safe_dump({}, f)

            with self.assertRaises(AssertionError):
                load_tts_config(path)


if __name__ == "__main__":
    unittest.main()
