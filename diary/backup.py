"""Compatible administrative entrypoint; run in the Linux Compose image."""

from diary.interfaces.cli.backup import main


if __name__ == "__main__":
    main()
