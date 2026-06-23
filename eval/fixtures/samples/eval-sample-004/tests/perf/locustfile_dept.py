from locust import HttpUser, between, task

class DeptListUser(HttpUser):
    wait_time = between(1, 2)

    @task
    def list_dept(self):
        self.client.get("/api/v1/dept/list", name="dept-list-query")
