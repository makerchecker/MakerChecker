import subprocess


class Runner:
    def run_cmd(self, cmd):
        # The agent can run any shell command here — no gate, no allowlist.
        process = subprocess.Popen(cmd, shell=True)
        return process.wait()

    def read_config(self, path):
        with open(path) as f:
            return f.read()
