COMPOSE       = docker compose -f ./docker-compose.yml
SCRIPT_CERTS  = ./scripts/setup-certs.sh

# Alvo principal (por omissão)
all: check-env certs build up
	@echo "=========================================================="
	@echo "  Transcendence is up and running!                        "
	@echo "  URL: https://localhost                                  "
	@echo "=========================================================="


check-env:
	@if [ ! -f .env ]; then \
		echo "=========================================================="; \
		echo "[!] ERROR: Configuration file .env not found!"; \
		echo ""; \
		echo "Please create your .env from the template before starting:"; \
		echo "  cp .env.example .env"; \
		echo "=========================================================="; \
		exit 1; \
	fi


certs:
	@chmod +x $(SCRIPT_CERTS)
	@$(SCRIPT_CERTS)


build: check-env certs
	@echo "Building Docker images..."
	@$(COMPOSE) build

up:
	@echo "Starting all containers in detached mode..."
	@$(COMPOSE) up -d

down:
	@echo "Stopping all containers..."
	@$(COMPOSE) down


ps:
	@$(COMPOSE) ps

logs:
	@if [ -z "$(SERVICE)" ]; then \
		$(COMPOSE) logs -f; \
	else \
		$(COMPOSE) logs -f $(SERVICE); \
	fi

# 5. Entrar num contentor interativamente
# Exemplo: make exec SERVICE=backend
#          make exec SERVICE=postgres
#          make exec SERVICE=vault
exec:
	@if [ -z "$(SERVICE)" ]; then \
		echo "Usage: make exec SERVICE=<service_name>"; \
		echo "Example: make exec SERVICE=backend"; \
		echo "         make exec SERVICE=postgres"; \
		echo "         make exec SERVICE=vault"; \
		exit 1; \
	else \
		$(COMPOSE) exec $(SERVICE) sh -c "bash || sh"; \
	fi

# 6. Atualizar código e reiniciar contentores sem perder dados da BD
update: check-env certs
	@echo "Rebuilding and updating containers..."
	@$(COMPOSE) build
	@$(COMPOSE) up -d --remove-orphans
	@echo "Transcendence updated!"

# 7. Modo dev local opcional (fora do Docker, se necessário)
dev:
	@echo "Starting backend locally in dev mode..."
	@npm --prefix backend run start:dev


clean:
	@echo "Stopping Transcendence containers..."
	@$(COMPOSE) down


fclean:
	@echo "Full cleaning Transcendence (containers, volumes, images, certs, backups)..."
	@$(COMPOSE) down -v --rmi all --remove-orphans
	@docker run --rm -v "$(CURDIR)/backups:/backups" alpine sh -c "rm -rf /backups/* /backups/.[!.]* 2>/dev/null || true"
	@rm -rf nginx/certs/ vault/certs/ backups/ backend/dist/
	@rm -rf backend/node_modules/ frontend/node_modules/
	@echo "Cleaned up all generated files, volumes, and images."

re: fclean all

.PHONY: all check-env certs build up down ps logs exec update dev clean fclean re