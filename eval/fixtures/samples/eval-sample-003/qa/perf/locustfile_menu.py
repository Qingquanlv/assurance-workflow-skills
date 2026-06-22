from locust import HttpUser, between, task

class MenuListUser(HttpUser):
    wait_time = between(1, 2)

    @task
    def list_menu(self):
        self.client.get("/api/v1/menu/list", name="menu-list-query")
